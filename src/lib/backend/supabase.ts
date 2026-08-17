// Supabase-backed backend: real auth (email + password) and Postgres
// persistence via RLS-protected tables (see supabase/migrations). Selected when
// VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are set.
//
// Conversations are resolved by (user_id, musician_id) rather than by their DB
// uuid, so the client never needs to round-trip to learn an id before sending
// the first message. Bookings and messages carry client-generated text ids.

import { supabase } from "../supabase";
import type { SceneId } from "../scenes";
import { normalizeOpeningScene, normalizeProjectScene } from "../sceneScope";
import type { Catalog } from "../data";
import type {
  Booking,
  Band,
  BookingCheckIn,
  BookingStatus,
  Conversation,
  CurrentUser,
  InstrumentId,
  Message,
  NotificationItem,
  NotificationPreferences,
  Opening,
  Player,
} from "../types";
import type { AuthResult, AuthUser, Backend, PersistedData } from "./types";

interface SessionUser {
  id: string;
  email?: string | null;
}

function toAuthUser(u: SessionUser | null | undefined): AuthUser | null {
  return u ? { id: u.id, email: u.email ?? null } : null;
}

/** rough relative-time label for openings ("just now", "3h", "2d"). */
function agoLabel(createdAt: string | null | undefined): string {
  if (!createdAt) return "just now";
  const mins = Math.max(0, (Date.now() - new Date(createdAt).getTime()) / 60_000);
  if (mins < 60) return mins < 2 ? "just now" : `${Math.round(mins)}m`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / (60 * 24))}d`;
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function fail(context: string, error: { message: string } | null): void {
  if (error) throw new Error(`${context}: ${error.message}`);
}

function avatarUrl(path: unknown): string | undefined {
  if (typeof path !== "string" || !path) return undefined;
  return supabase.storage.from("avatars").getPublicUrl(path).data.publicUrl;
}

function mapBookingCheckIn(
  row: Record<string, unknown>,
  recordingUrl?: string,
): BookingCheckIn {
  return {
    id: row.id as string,
    dueAt: row.due_at as string,
    request: row.request as string,
    status: row.status as BookingCheckIn["status"],
    recordingUrl,
    recordingName: (row.recording_name as string | null) ?? undefined,
    submittedAt: (row.submitted_at as string | null) ?? undefined,
    reviewedAt: (row.reviewed_at as string | null) ?? undefined,
    reviewNote: (row.review_note as string | null) ?? undefined,
  };
}

async function signedCheckInUrl(path: unknown): Promise<string | undefined> {
  if (typeof path !== "string" || !path) return undefined;
  const { data, error } = await supabase.storage
    .from("booking-check-ins")
    .createSignedUrl(path, 60 * 60);
  fail("sign check-in recording", error);
  return data?.signedUrl;
}

function profileSeed(id: string): number {
  let value = 0;
  for (const char of id) value = (value * 31 + char.charCodeAt(0)) % 10_000;
  return value || 1;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isAccountPlayerId(id: string): boolean {
  return UUID_PATTERN.test(id);
}

async function getOrCreateDirectConversation(userId: string, playerId: string): Promise<string> {
  const [participantA, participantB] = [userId, playerId].sort();
  const find = () => supabase
    .from("direct_conversations")
    .select("id")
    .eq("participant_a", participantA)
    .eq("participant_b", participantB)
    .maybeSingle();

  const existing = await find();
  fail("find direct conversation", existing.error);
  if (existing.data) return (existing.data as { id: string }).id;

  const created = await supabase
    .from("direct_conversations")
    .insert({ participant_a: participantA, participant_b: participantB })
    .select("id")
    .single();
  if (!created.error) return (created.data as { id: string }).id;

  // Two first messages can race to create the same canonical pair. The unique
  // constraint picks one winner; the loser reads that row and continues.
  if ((created.error as { code?: string }).code === "23505") {
    const raced = await find();
    fail("load raced direct conversation", raced.error);
    if (raced.data) return (raced.data as { id: string }).id;
  }
  fail("create direct conversation", created.error);
  throw new Error("create direct conversation failed");
}

/** Keep catalog roots within the active scene before their dependents are loaded. */
export function filterCatalogRoots<T extends Record<string, unknown>>(rows: T[], scene: SceneId): T[] {
  return rows.filter((row) => row.scene === scene);
}

export const supabaseBackend: Backend = {
  mode: "supabase",

  subscribeToChanges(user, onChange) {
    const channel = supabase
      .channel(`backline:user:${user.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "direct_messages" },
        onChange,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "bookings" },
        onChange,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "booking_check_ins" },
        onChange,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "notifications" },
        onChange,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "profiles" },
        onChange,
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  },

  async getSession() {
    const { data } = await supabase.auth.getSession();
    return toAuthUser(data.session?.user);
  },

  onAuthChange(cb) {
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      cb(toAuthUser(session?.user));
    });
    return () => data.subscription.unsubscribe();
  },

  async signUp(email, password, name): Promise<AuthResult> {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { name } },
    });
    if (error) return { error: error.message };
    // No session back → the project requires email confirmation before sign-in.
    return { error: null, needsConfirmation: !data.session };
  },

  async signIn(email, password): Promise<AuthResult> {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error ? error.message : null };
  },

  async signOut() {
    await supabase.auth.signOut();
  },

  async resetPassword(email): Promise<AuthResult> {
    const redirectTo =
      typeof window !== "undefined" ? `${window.location.origin}/welcome` : undefined;
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    return { error: error ? error.message : null };
  },

  async loadCatalog(scene: SceneId): Promise<Catalog | null> {
    // Cloud mode is account-backed. The legacy musician/band/venue/feed tables
    // contain the prototype seed and must never be mixed into a hosted beta.
    // Local mode remains the explicit home for that demo catalog.
    type ProfileRow = Record<string, unknown>;
    const [profiles, activeAvailability] = await Promise.all([
      supabase
        .from("profiles")
        .select(
          "id,scene,name,handle,instruments,genres,bio,gear,neighborhood,rate_min,rate_max,availability,reels,avatar_path,created_at",
        )
        .eq("scene", scene)
        .not("handle", "is", null)
        .order("created_at"),
      supabase.rpc("list_available_players"),
    ]);
    fail("load catalog profiles", profiles.error);
    const profileRows = filterCatalogRoots(
      (profiles.data ?? []) as ProfileRow[],
      scene,
    );
    // Signed-out catalog loads cannot call the authenticated RPC; they simply
    // show no live badges. Exact availability locations are never returned.
    const activeProfileIds = new Set(
      activeAvailability.error
        ? []
        : ((activeAvailability.data ?? []) as { profile_id: string }[]).map((row) => row.profile_id),
    );

    const profilePlayers: Player[] = profileRows.map((p) => ({
      id: p.id as string,
      scene: p.scene as SceneId,
      name: (p.name as string) ?? "Player",
      handle: p.handle as string,
      instruments: ((p.instruments as InstrumentId[]) ?? []).map((id) => ({
        id,
        level: "semi-pro" as const,
        years: 0,
      })),
      genres: (p.genres as string[]) ?? [],
      bio: (p.bio as string) ?? "",
      gear: (p.gear as string[]) ?? [],
      neighborhood: (p.neighborhood as string) ?? "",
      distanceMiles: 0,
      rate: {
        min: (p.rate_min as number) ?? 0,
        max: (p.rate_max as number) ?? 0,
      },
      availableTonight: activeProfileIds.has(p.id as string),
      availability: (p.availability as string[]) ?? [],
      responseMins: 0,
      gigsPlayed: 0,
      verified: false,
      reels: Array.isArray(p.reels) ? p.reels as Player["reels"] : [],
      videos: [],
      reviews: [],
      bandIds: [],
      seed: profileSeed(p.id as string),
      avatarUrl: avatarUrl(p.avatar_path),
    }));

    return {
      players: profilePlayers,
      bands: [],
      venues: [],
      events: [],
      feedPosts: [],
    };
  },

  async load(user): Promise<PersistedData> {
    const empty: PersistedData = {
      user: null,
      following: [],
      conversations: [],
      bookings: [],
      notifications: [],
      notificationPreferences: {
        pushEnabled: false,
        highPush: true,
        normalPush: false,
        hardMute: false,
        quietStart: "22:00",
        quietEnd: "08:00",
        timezone: "America/Chicago",
      },
      likedPosts: [],
      respondedSubPosts: [],
      openings: [],
      projects: [],
    };
    if (!user) return empty;

    const [
      profileRes,
      availabilityRes,
      followsRes,
      bookingsRes,
      checkInsRes,
      convosRes,
      messagesRes,
      directConvosRes,
      directMessagesRes,
      directReadsRes,
      notificationsRes,
      notificationPreferencesRes,
      likesRes,
      subsRes,
      openingsRes,
      projectsRes,
      groupsRes,
    ] =
      await Promise.all([
        supabase.from("profiles").select("*").eq("id", user.id).maybeSingle(),
        supabase
          .from("player_availability")
          .select("available_until")
          .eq("user_id", user.id)
          .gt("available_until", new Date().toISOString())
          .maybeSingle(),
        supabase.from("follows").select("target_id").eq("user_id", user.id),
        supabase.from("bookings").select("*").order("created_at"),
        supabase.from("booking_check_ins").select("*").order("due_at"),
        supabase.from("conversations").select("*").eq("user_id", user.id),
        supabase
          .from("messages")
          .select("*, conversations!inner(user_id, musician_id)")
          .eq("conversations.user_id", user.id)
          .order("created_at"),
        supabase
          .from("direct_conversations")
          .select("*")
          .or(`participant_a.eq.${user.id},participant_b.eq.${user.id}`),
        supabase.from("direct_messages").select("*").order("created_at"),
        supabase
          .from("direct_conversation_reads")
          .select("conversation_id,read_at")
          .eq("user_id", user.id),
        supabase
          .from("notifications")
          .select("id,kind,urgency,title,body,href,read_at,created_at")
          .order("created_at", { ascending: false })
          .limit(100),
        supabase
          .from("notification_preferences")
          .select("push_enabled,high_push,normal_push,hard_mute,quiet_start,quiet_end,timezone")
          .eq("user_id", user.id)
          .maybeSingle(),
        supabase.from("liked_posts").select("post_id").eq("user_id", user.id),
        supabase.from("responded_sub_posts").select("post_id").eq("user_id", user.id),
        supabase.from("openings").select("*").eq("user_id", user.id).order("created_at", { ascending: false }),
        supabase.from("user_projects").select("*").eq("user_id", user.id).order("updated_at", { ascending: false }),
        supabase.from("group_conversations").select("*").eq("user_id", user.id).order("updated_at", { ascending: false }),
      ]);

    fail("load profile", profileRes.error);
    fail("load availability", availabilityRes.error);
    fail("load follows", followsRes.error);
    fail("load bookings", bookingsRes.error);
    fail("load booking check-ins", checkInsRes.error);
    fail("load conversations", convosRes.error);
    fail("load messages", messagesRes.error);
    fail("load direct conversations", directConvosRes.error);
    fail("load direct messages", directMessagesRes.error);
    fail("load direct read markers", directReadsRes.error);
    fail("load notifications", notificationsRes.error);
    fail("load notification preferences", notificationPreferencesRes.error);
    fail("load likes", likesRes.error);
    fail("load sub-responses", subsRes.error);
    fail("load openings", openingsRes.error);
    fail("load projects", projectsRes.error);
    fail("load group chats", groupsRes.error);

    const p = profileRes.data as Record<string, unknown> | null;
    const activeAvailability = availabilityRes.data as { available_until: string } | null;
    // A profile row is created by a DB trigger at sign-up with no handle yet;
    // treat the user as "onboarded" (and skip the welcome flow) only once they
    // have picked a handle.
    const profile: CurrentUser | null = p && p.handle
      ? {
          id: user.id,
          name: (p.name as string) ?? "",
          handle: (p.handle as string) ?? "",
          instruments: ((p.instruments as InstrumentId[]) ?? []),
          neighborhood: (p.neighborhood as string) ?? "",
          availableTonight: Boolean(activeAvailability),
          availableUntil: activeAvailability?.available_until,
          scene: (p.scene as SceneId) ?? "austin",
          bio: (p.bio as string) ?? "",
          genres: (p.genres as string[]) ?? [],
          gear: (p.gear as string[]) ?? [],
          availability: (p.availability as string[]) ?? [],
          rate: {
            min: (p.rate_min as number) ?? 0,
            max: (p.rate_max as number) ?? 0,
          },
          reels: Array.isArray(p.reels) ? p.reels as CurrentUser["reels"] : [],
          avatarUrl: avatarUrl(p.avatar_path),
        }
      : null;

    // group messages under their conversation
    const byConversation = new Map<string, Message[]>();
    for (const row of (messagesRes.data ?? []) as Record<string, unknown>[]) {
      const convId = row.conversation_id as string;
      const list = byConversation.get(convId) ?? [];
      list.push({
        id: row.id as string,
        from: row.sender === "musician" ? "them" : "me",
        text: (row.body as string | null) ?? undefined,
        bookingId: (row.booking_id as string | null) ?? undefined,
        at: timeLabel(row.created_at as string),
      });
      byConversation.set(convId, list);
    }

    const conversations: Conversation[] = ((convosRes.data ?? []) as Record<string, unknown>[]).map(
      (c) => ({
        id: c.id as string,
        playerId: c.musician_id as string,
        unread: (c.unread as number) ?? 0,
        messages: byConversation.get(c.id as string) ?? [],
      }),
    );

    const directMessagesByConversation = new Map<string, Record<string, unknown>[]>();
    for (const row of (directMessagesRes.data ?? []) as Record<string, unknown>[]) {
      const conversationId = row.conversation_id as string;
      const rows = directMessagesByConversation.get(conversationId) ?? [];
      rows.push(row);
      directMessagesByConversation.set(conversationId, rows);
    }
    const readAtByConversation = new Map(
      ((directReadsRes.data ?? []) as { conversation_id: string; read_at: string }[])
        .map((row) => [row.conversation_id, new Date(row.read_at).getTime()]),
    );
    const directConversations: Conversation[] = (
      (directConvosRes.data ?? []) as Record<string, unknown>[]
    ).map((conversation) => {
      const conversationId = conversation.id as string;
      const playerId = conversation.participant_a === user.id
        ? conversation.participant_b as string
        : conversation.participant_a as string;
      const rows = directMessagesByConversation.get(conversationId) ?? [];
      const readAt = readAtByConversation.get(conversationId) ?? 0;
      return {
        id: conversationId,
        kind: "dm" as const,
        playerId,
        messages: rows.map((row) => ({
          id: row.id as string,
          from: row.sender_id === user.id ? "me" as const : "them" as const,
          text: (row.body as string | null) ?? undefined,
          bookingId: (row.booking_id as string | null) ?? undefined,
          at: timeLabel(row.created_at as string),
        })),
        unread: rows.filter((row) => (
          row.sender_id !== user.id && new Date(row.created_at as string).getTime() > readAt
        )).length,
      };
    });

    const checkInsByBooking = new Map<string, BookingCheckIn[]>();
    const signedCheckIns = await Promise.all(
      ((checkInsRes.data ?? []) as Record<string, unknown>[]).map(async (row) => ({
        row,
        checkIn: mapBookingCheckIn(row, await signedCheckInUrl(row.recording_path)),
      })),
    );
    for (const { row, checkIn } of signedCheckIns) {
      const bookingId = row.booking_id as string;
      checkInsByBooking.set(bookingId, [...(checkInsByBooking.get(bookingId) ?? []), checkIn]);
    }

    const bookings: Booking[] = ((bookingsRes.data ?? []) as Record<string, unknown>[]).map((b) => ({
      id: b.id as string,
      playerId: b.user_id === user.id ? b.musician_id as string : b.user_id as string,
      gigTitle: b.gig_title as string,
      venueName: b.venue_name as string,
      date: b.date as string,
      time: b.time as string,
      gigAt: (b.gig_at as string) ?? undefined,
      amount: (b.amount as number) ?? 0,
      // legacy escrow rename: rows written before held/released say "paid"
      status: (b.status === "paid" ? "held" : b.status) as BookingStatus,
      openingId: (b.opening_id as string) ?? undefined,
      direction: b.user_id === user.id ? "outgoing" : "incoming",
      checkIns: checkInsByBooking.get(b.id as string) ?? [],
    }));

    const notifications: NotificationItem[] = (
      (notificationsRes.data ?? []) as Record<string, unknown>[]
    ).map((notification) => ({
      id: notification.id as string,
      kind: notification.kind as NotificationItem["kind"],
      urgency: notification.urgency as NotificationItem["urgency"],
      title: notification.title as string,
      body: (notification.body as string) ?? "",
      href: notification.href as string,
      createdAt: notification.created_at as string,
      read: notification.read_at != null,
    }));
    const preferenceRow = notificationPreferencesRes.data as Record<string, unknown> | null;
    const notificationPreferences: NotificationPreferences = {
      pushEnabled: Boolean(preferenceRow?.push_enabled),
      highPush: preferenceRow ? Boolean(preferenceRow.high_push) : true,
      normalPush: Boolean(preferenceRow?.normal_push),
      hardMute: Boolean(preferenceRow?.hard_mute),
      quietStart: String(preferenceRow?.quiet_start ?? "22:00").slice(0, 5),
      quietEnd: String(preferenceRow?.quiet_end ?? "08:00").slice(0, 5),
      timezone: String(preferenceRow?.timezone ?? "America/Chicago"),
    };

    // group chats are stored as whole documents; they join the DM list
    const groupConversations = ((groupsRes.data ?? []) as Record<string, unknown>[]).map(
      (g) => g.data as Conversation,
    );

    return {
      user: profile,
      following: ((followsRes.data ?? []) as { target_id: string }[]).map((f) => f.target_id),
      conversations: [...groupConversations, ...directConversations, ...conversations],
      bookings,
      notifications,
      notificationPreferences,
      likedPosts: ((likesRes.data ?? []) as { post_id: string }[]).map((l) => l.post_id),
      respondedSubPosts: ((subsRes.data ?? []) as { post_id: string }[]).map((s) => s.post_id),
      openings: ((openingsRes.data ?? []) as Record<string, unknown>[]).map((o) => normalizeOpeningScene({
        id: o.id as string,
        scene: o.scene as SceneId,
        instrument: o.instrument as Opening["instrument"],
        postedBy: {
          kind: o.posted_by_kind as Opening["postedBy"]["kind"],
          id: o.posted_by_id as string,
        },
        eventId: (o.event_id as string) ?? undefined,
        gigAt: (o.gig_at as string) ?? undefined,
        when: o.when_label as string,
        fee: (o.fee as number) ?? 0,
        note: (o.note as string) ?? undefined,
        urgent: Boolean(o.urgent),
        status: (o.status as Opening["status"]) ?? "open",
        ago: agoLabel(o.created_at as string),
      } as Omit<Opening, "scene">)),
      projects: ((projectsRes.data ?? []) as Record<string, unknown>[]).map(
        (p) => normalizeProjectScene(p.data as Omit<Band, "scene">),
      ),
    };
  },

  async saveUser(user, profile) {
    const { error } = await supabase.from("profiles").upsert({
      id: user.id,
      name: profile.name,
      handle: profile.handle,
      neighborhood: profile.neighborhood,
      instruments: profile.instruments,
      scene: profile.scene,
      bio: profile.bio ?? "",
      genres: profile.genres ?? [],
      gear: profile.gear ?? [],
      availability: profile.availability ?? [],
      rate_min: profile.rate?.min ?? null,
      rate_max: profile.rate?.max ?? null,
      reels: profile.reels ?? [],
      updated_at: new Date().toISOString(),
    });
    fail("save profile", error);
    if (profile.availableTonight) {
      const availableUntil = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
      const availability = await supabase.rpc("set_my_availability", {
        p_available_until: availableUntil,
        p_latitude: null,
        p_longitude: null,
      });
      fail("set onboarding availability", availability.error);
    }
  },

  async updateUser(user, patch) {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.handle !== undefined) row.handle = patch.handle;
    if (patch.neighborhood !== undefined) row.neighborhood = patch.neighborhood;
    if (patch.instruments !== undefined) row.instruments = patch.instruments;
    if (patch.scene !== undefined) row.scene = patch.scene;
    if (patch.bio !== undefined) row.bio = patch.bio;
    if (patch.genres !== undefined) row.genres = patch.genres;
    if (patch.gear !== undefined) row.gear = patch.gear;
    if (patch.availability !== undefined) row.availability = patch.availability;
    if (patch.rate !== undefined) {
      row.rate_min = patch.rate.min;
      row.rate_max = patch.rate.max;
    }
    if (patch.reels !== undefined) row.reels = patch.reels;
    const { error } = await supabase.from("profiles").update(row).eq("id", user.id);
    fail("update profile", error);
  },

  async setAvailability(_user, availableUntil, location) {
    const { error } = await supabase.rpc("set_my_availability", {
      p_available_until: availableUntil,
      p_latitude: location?.latitude ?? null,
      p_longitude: location?.longitude ?? null,
    });
    fail("set availability", error);
  },

  async clearAvailability() {
    const { error } = await supabase.rpc("clear_my_availability");
    fail("clear availability", error);
  },

  async findAvailablePlayers(_user, selectedInstrument, maxDistanceMiles = 25) {
    const { data, error } = await supabase.rpc("find_available_players", {
      p_instrument: selectedInstrument,
      p_max_distance_miles: maxDistanceMiles,
    });
    fail("find available players", error);
    return ((data ?? []) as Array<{
      profile_id: string;
      available_until: string;
      distance_miles: number | string | null;
    }>).map((row) => ({
      playerId: row.profile_id,
      availableUntil: row.available_until,
      distanceMiles: row.distance_miles == null ? null : Number(row.distance_miles),
    }));
  },

  async createSosBroadcast(_user, selectedInstrument, whenLabel, openingId, maxDistanceMiles = 25) {
    const { data, error } = await supabase.rpc("create_sos_broadcast", {
      p_instrument: selectedInstrument,
      p_when_label: whenLabel,
      p_opening_id: openingId ?? null,
      p_max_distance_miles: maxDistanceMiles,
    });
    fail("create SOS broadcast", error);
    const row = (data as Array<{ broadcast_id: string; recipient_count: number }> | null)?.[0];
    if (!row) throw new Error("create SOS broadcast: no result returned");
    return { broadcastId: row.broadcast_id, recipientCount: row.recipient_count };
  },

  async getSosBroadcast(_user, broadcastId) {
    const { data, error } = await supabase.rpc("get_sos_broadcast", {
      p_broadcast_id: broadcastId,
    });
    fail("load SOS broadcast", error);
    const row = (data as Array<Record<string, unknown>> | null)?.[0];
    if (!row) throw new Error("SOS broadcast was not found.");
    return {
      broadcastId: row.broadcast_id as string,
      requesterId: row.requester_id as string,
      requesterName: row.requester_name as string,
      instrument: row.instrument as InstrumentId,
      whenLabel: row.when_label as string,
      status: row.status as "open" | "matched" | "expired" | "cancelled",
      expiresAt: row.expires_at as string,
      acceptedBy: (row.accepted_by as string | null) ?? null,
      canAccept: Boolean(row.can_accept),
    };
  },

  async acceptSosBroadcast(_user, broadcastId) {
    const { error } = await supabase.rpc("accept_sos_broadcast", {
      p_broadcast_id: broadcastId,
    });
    fail("accept SOS broadcast", error);
  },

  async uploadAvatar(user, file) {
    const extension = file.type === "image/png"
      ? "png"
      : file.type === "image/webp"
        ? "webp"
        : "jpg";
    const path = `${user.id}/avatar-${Date.now()}.${extension}`;
    const existing = await supabase
      .from("profiles")
      .select("avatar_path")
      .eq("id", user.id)
      .maybeSingle();
    fail("load current avatar", existing.error);

    const uploaded = await supabase.storage.from("avatars").upload(path, file, {
      cacheControl: "31536000",
      contentType: file.type,
      upsert: false,
    });
    fail("upload avatar", uploaded.error);

    const saved = await supabase
      .from("profiles")
      .update({ avatar_path: path, updated_at: new Date().toISOString() })
      .eq("id", user.id);
    if (saved.error) {
      await supabase.storage.from("avatars").remove([path]);
      fail("save avatar", saved.error);
    }

    const oldPath = (existing.data as { avatar_path?: string | null } | null)?.avatar_path;
    if (oldPath && oldPath !== path) {
      await supabase.storage.from("avatars").remove([oldPath]);
    }
    return avatarUrl(path)!;
  },

  async setFollow(user, targetId, following) {
    if (following) {
      const { error } = await supabase
        .from("follows")
        .upsert({ user_id: user.id, target_id: targetId });
      fail("add follow", error);
    } else {
      const { error } = await supabase
        .from("follows")
        .delete()
        .eq("user_id", user.id)
        .eq("target_id", targetId);
      fail("remove follow", error);
    }
  },

  async addMessage(user, playerId, message) {
    if (isAccountPlayerId(playerId)) {
      const conversationId = await getOrCreateDirectConversation(user.id, playerId);
      const { error } = await supabase.from("direct_messages").insert({
        id: message.id,
        conversation_id: conversationId,
        sender_id: user.id,
        body: message.text ?? null,
        booking_id: message.bookingId ?? null,
      });
      fail("insert direct message", error);
      return;
    }

    // upsert the conversation (unread untouched on conflict) and get its id
    const { data: conv, error: convErr } = await supabase
      .from("conversations")
      .upsert(
        { user_id: user.id, musician_id: playerId },
        { onConflict: "user_id,musician_id" },
      )
      .select("id,unread")
      .single();
    fail("upsert conversation", convErr);
    const conversationId = (conv as { id: string }).id;

    const { error: msgErr } = await supabase.from("messages").insert({
      id: message.id,
      conversation_id: conversationId,
      sender: message.from === "them" ? "musician" : "user",
      body: message.text ?? null,
      booking_id: message.bookingId ?? null,
    });
    fail("insert message", msgErr);

    if (message.from === "them") {
      const nextUnread = ((conv as { unread: number }).unread ?? 0) + 1;
      const { error: unreadErr } = await supabase
        .from("conversations")
        .update({ unread: nextUnread })
        .eq("id", conversationId);
      fail("bump unread", unreadErr);
    }
  },

  async markRead(user, playerId) {
    if (isAccountPlayerId(playerId)) {
      const [participantA, participantB] = [user.id, playerId].sort();
      const conversation = await supabase
        .from("direct_conversations")
        .select("id")
        .eq("participant_a", participantA)
        .eq("participant_b", participantB)
        .maybeSingle();
      fail("find direct conversation to mark read", conversation.error);
      if (!conversation.data) return;
      const { error } = await supabase.from("direct_conversation_reads").upsert({
        conversation_id: (conversation.data as { id: string }).id,
        user_id: user.id,
        read_at: new Date().toISOString(),
      });
      fail("mark direct conversation read", error);
      return;
    }

    const { error } = await supabase
      .from("conversations")
      .update({ unread: 0 })
      .eq("user_id", user.id)
      .eq("musician_id", playerId);
    fail("mark read", error);
  },

  async addBooking(user, booking) {
    const realRecipient = isAccountPlayerId(booking.playerId);
    const checkIns = booking.checkIns ?? [];
    if (checkIns.length > 0) {
      if (!realRecipient || !booking.gigAt) {
        throw new Error("Check-ins require an account-backed player and scheduled showtime.");
      }
      const { error } = await supabase.rpc("create_booking_offer_with_check_ins", {
        p_id: booking.id,
        p_musician_user_id: booking.playerId,
        p_gig_title: booking.gigTitle,
        p_venue_name: booking.venueName,
        p_date: booking.date,
        p_time: booking.time,
        p_gig_at: booking.gigAt,
        p_amount: booking.amount,
        p_opening_id: booking.openingId ?? null,
        p_check_ins: checkIns.map((checkIn) => ({
          id: checkIn.id,
          due_at: checkIn.dueAt,
          request: checkIn.request,
        })),
      });
      fail("add booking with check-ins", error);
      return;
    }
    const { error } = await supabase.from("bookings").insert({
      id: booking.id,
      user_id: user.id,
      musician_id: booking.playerId,
      musician_user_id: realRecipient ? booking.playerId : null,
      gig_title: booking.gigTitle,
      venue_name: booking.venueName,
      date: booking.date,
      time: booking.time,
      gig_at: booking.gigAt ?? null,
      amount: booking.amount,
      status: booking.status,
      opening_id: booking.openingId ?? null,
    });
    fail("add booking", error);
  },

  async setBookingStatus(_user, bookingId, status) {
    const { error } = await supabase
      .from("bookings")
      .update({ status })
      .eq("id", bookingId);
    fail("set booking status", error);
  },

  async submitBookingCheckIn(user, bookingId, checkInId, file) {
    if (!file.type.startsWith("video/")) {
      throw new Error("Check-in recordings must be video files.");
    }
    if (file.size > 50 * 1024 * 1024) {
      throw new Error("Check-in recordings must be 50 MB or smaller.");
    }
    const existing = await supabase
      .from("booking_check_ins")
      .select("recording_path")
      .eq("id", checkInId)
      .eq("booking_id", bookingId)
      .single();
    fail("load check-in", existing.error);

    const extension = file.type === "video/quicktime"
      ? "mov"
      : file.type === "video/webm"
        ? "webm"
        : file.type === "video/x-m4v"
          ? "m4v"
          : "mp4";
    const path = `${bookingId}/${checkInId}/${user.id}/${crypto.randomUUID()}.${extension}`;
    const uploaded = await supabase.storage.from("booking-check-ins").upload(path, file, {
      cacheControl: "3600",
      contentType: file.type,
      upsert: false,
    });
    fail("upload check-in recording", uploaded.error);

    const saved = await supabase
      .from("booking_check_ins")
      .update({
        status: "submitted",
        recording_path: path,
        recording_name: file.name.slice(0, 240),
      })
      .eq("id", checkInId)
      .eq("booking_id", bookingId)
      .select("*")
      .single();
    if (saved.error) {
      await supabase.storage.from("booking-check-ins").remove([path]);
      fail("submit check-in", saved.error);
    }

    const oldPath = (existing.data as { recording_path?: string | null } | null)?.recording_path;
    if (oldPath && oldPath !== path) {
      await supabase.storage.from("booking-check-ins").remove([oldPath]);
    }
    return mapBookingCheckIn(
      saved.data as Record<string, unknown>,
      await signedCheckInUrl(path),
    );
  },

  async reviewBookingCheckIn(_user, bookingId, checkInId, status, note) {
    const saved = await supabase
      .from("booking_check_ins")
      .update({ status, review_note: note?.trim() || null })
      .eq("id", checkInId)
      .eq("booking_id", bookingId)
      .select("*")
      .single();
    fail("review check-in", saved.error);
    const row = saved.data as Record<string, unknown>;
    return mapBookingCheckIn(row, await signedCheckInUrl(row.recording_path));
  },

  async markNotificationRead(_user, notificationId) {
    const { error } = await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("id", notificationId);
    fail("mark notification read", error);
  },

  async markAllNotificationsRead(_user) {
    const { error } = await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .is("read_at", null);
    fail("mark all notifications read", error);
  },

  async savePushSubscription(user, subscription, userAgent, timezone) {
    const endpoint = subscription.endpoint;
    const p256dh = subscription.keys?.p256dh;
    const auth = subscription.keys?.auth;
    if (!endpoint || !p256dh || !auth) throw new Error("Push subscription is incomplete.");

    const { error: subscriptionError } = await supabase.from("push_subscriptions").upsert(
      {
        user_id: user.id,
        endpoint,
        p256dh,
        auth,
        user_agent: userAgent.slice(0, 500),
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: "endpoint" },
    );
    fail("save push subscription", subscriptionError);

    const { error: preferenceError } = await supabase.from("notification_preferences").upsert({
      user_id: user.id,
      push_enabled: true,
      timezone,
      updated_at: new Date().toISOString(),
    });
    fail("enable push preference", preferenceError);
  },

  async removePushSubscription(user, endpoint) {
    const { error: subscriptionError } = await supabase
      .from("push_subscriptions")
      .delete()
      .eq("user_id", user.id)
      .eq("endpoint", endpoint);
    fail("remove push subscription", subscriptionError);

    const { error: preferenceError } = await supabase
      .from("notification_preferences")
      .update({ push_enabled: false, updated_at: new Date().toISOString() })
      .eq("user_id", user.id);
    fail("disable push preference", preferenceError);
  },

  async updateNotificationPreferences(user, patch) {
    const row: Record<string, unknown> = {
      user_id: user.id,
      updated_at: new Date().toISOString(),
    };
    if (patch.pushEnabled !== undefined) row.push_enabled = patch.pushEnabled;
    if (patch.highPush !== undefined) row.high_push = patch.highPush;
    if (patch.normalPush !== undefined) row.normal_push = patch.normalPush;
    if (patch.hardMute !== undefined) row.hard_mute = patch.hardMute;
    if (patch.quietStart !== undefined) row.quiet_start = patch.quietStart;
    if (patch.quietEnd !== undefined) row.quiet_end = patch.quietEnd;
    if (patch.timezone !== undefined) row.timezone = patch.timezone;
    const { error } = await supabase.from("notification_preferences").upsert(row);
    fail("update notification preferences", error);
  },

  async createPayoutOnboardingLink(_user) {
    const { data, error } = await supabase.functions.invoke("create-connect-onboarding-link", {
      body: {},
    });
    fail("start payout onboarding", error);
    const rawUrl = (data as { url?: unknown } | null)?.url;
    if (typeof rawUrl !== "string") throw new Error("Stripe onboarding link missing");
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.hostname !== "connect.stripe.com") {
      throw new Error("Stripe onboarding link invalid");
    }
    return url.toString();
  },

  async createBookingPaymentIntent(_user, bookingId) {
    const { data, error } = await supabase.functions.invoke("create-booking-payment-intent", {
      body: { bookingId },
    });
    fail("start booking payment", error);
    const clientSecret = (data as { clientSecret?: unknown } | null)?.clientSecret;
    if (typeof clientSecret !== "string" || !clientSecret.startsWith("pi_")) {
      throw new Error("Stripe client secret missing");
    }
    return clientSecret;
  },

  async fileBookingDispute(user, bookingId, reason, details) {
    const { error } = await supabase.from("booking_disputes").insert({
      booking_id: bookingId,
      filed_by: user.id,
      reason,
      details,
    });
    fail("file booking dispute", error);
  },

  async cancelHeldBooking(_user, bookingId) {
    const { error } = await supabase.functions.invoke("cancel-held-booking", {
      body: { bookingId },
    });
    fail("cancel held booking", error);
  },

  async addOpening(user, opening) {
    const { error } = await supabase.from("openings").insert({
      id: opening.id,
      user_id: user.id,
      scene: opening.scene,
      instrument: opening.instrument,
      posted_by_kind: opening.postedBy.kind,
      posted_by_id: opening.postedBy.id,
      event_id: opening.eventId ?? null,
      gig_at: opening.gigAt ?? null,
      when_label: opening.when,
      fee: opening.fee,
      note: opening.note ?? null,
      urgent: opening.urgent ?? false,
      status: opening.status,
    });
    fail("add opening", error);
  },

  async setOpeningStatus(user, openingId, status) {
    const { error } = await supabase
      .from("openings")
      .update({ status })
      .eq("id", openingId)
      .eq("user_id", user.id);
    fail("set opening status", error);
  },

  async upsertProject(user, project) {
    const { error } = await supabase.from("user_projects").upsert({
      id: project.id,
      user_id: user.id,
      data: project,
      updated_at: new Date().toISOString(),
    });
    fail("upsert project", error);
  },

  async upsertConversation(user, conversation) {
    // whole-document write, matching the store's upsert seam. DMs never take
    // this path (they persist row-by-row via addMessage/markRead).
    const { error } = await supabase.from("group_conversations").upsert({
      id: conversation.id,
      user_id: user.id,
      data: conversation,
      updated_at: new Date().toISOString(),
    });
    fail("upsert group chat", error);
  },

  async setLike(user, postId, liked) {
    if (liked) {
      const { error } = await supabase
        .from("liked_posts")
        .upsert({ user_id: user.id, post_id: postId });
      fail("add like", error);
    } else {
      const { error } = await supabase
        .from("liked_posts")
        .delete()
        .eq("user_id", user.id)
        .eq("post_id", postId);
      fail("remove like", error);
    }
  },

  async addRespondedSub(user, postId) {
    const { error } = await supabase
      .from("responded_sub_posts")
      .upsert({ user_id: user.id, post_id: postId });
    fail("respond to sub", error);
  },

  async reset(user) {
    // clear this user's activity; the profile + account stay.
    const results = await Promise.all([
      supabase.from("follows").delete().eq("user_id", user.id),
      supabase.from("bookings").delete().eq("user_id", user.id),
      supabase.from("conversations").delete().eq("user_id", user.id),
      supabase.from("liked_posts").delete().eq("user_id", user.id),
      supabase.from("responded_sub_posts").delete().eq("user_id", user.id),
      supabase.from("openings").delete().eq("user_id", user.id),
      supabase.from("user_projects").delete().eq("user_id", user.id),
      supabase.from("group_conversations").delete().eq("user_id", user.id),
    ]);
    results.forEach((result, index) => fail(`reset activity ${index + 1}`, result.error));
  },
};
