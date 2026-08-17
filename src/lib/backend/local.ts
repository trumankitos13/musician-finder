// localStorage-backed backend — the demo/prototype experience with no real
// auth or server. Selected automatically when Supabase env vars are absent, so
// the app (and the deployed site) always runs, even before the backend is set
// up. Behavior matches the original SitIn prototype.

import type { Band, Booking, BookingCheckIn, BookingDisputeReason, BookingStatus, Conversation, CurrentUser, Message, NotificationPreferences, Opening } from "../types";
import { demoCatalogForScene, SEED_CONVERSATIONS } from "../data";
import { upsertMessage } from "../conversations";
import { normalizePersistedData } from "../sceneScope";
import type { AuthResult, AuthUser, Backend, PersistedData } from "./types";

const STORAGE_KEY = "backline-state-v1";

// Local mode has no accounts; every write is attributed to this synthetic user.
const LOCAL_USER: AuthUser = { id: "local", email: null };
const localSosBroadcasts = new Map<string, {
  requesterName: string;
  instrument: CurrentUser["instruments"][number];
  whenLabel: string;
  status: "open" | "matched";
  expiresAt: string;
}>();

function demoDefault(): PersistedData {
  return {
    user: null,
    following: ["v-armadillo", "v-rattlesnake", "b-moontower", "b-brasshouse"],
    conversations: SEED_CONVERSATIONS,
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
}

/** legacy escrow rename: persisted "paid" (pre-held/released) means "held". */
function migrateBooking(b: Booking): Booking {
  return (b.status as string) === "paid" ? { ...b, status: "held" } : b;
}

function read(): PersistedData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return demoDefault();
    const parsed = JSON.parse(raw) as Partial<PersistedData>;
    const merged = { ...demoDefault(), ...parsed };
    return normalizePersistedData({ ...merged, bookings: merged.bookings.map(migrateBooking) });
  } catch {
    return demoDefault();
  }
}

function write(data: PersistedData): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // storage full or unavailable — the app keeps working from memory
  }
}

function mutate(fn: (d: PersistedData) => PersistedData): void {
  write(fn(read()));
}

export const localBackend: Backend = {
  mode: "local",

  subscribeToChanges() {
    return () => undefined;
  },

  async getSession() {
    // Local mode is always "signed in"; onboarding (state.user) is the real gate.
    return LOCAL_USER;
  },
  onAuthChange() {
    return () => {};
  },
  async signUp(): Promise<AuthResult> {
    return { error: "Accounts require Supabase — this build is in demo mode." };
  },
  async signIn(): Promise<AuthResult> {
    return { error: "Accounts require Supabase — this build is in demo mode." };
  },
  async signOut() {
    // no session to end in demo mode
  },
  async resetPassword(): Promise<AuthResult> {
    return { error: "Accounts require Supabase — this build is in demo mode." };
  },

  async loadCatalog(scene) {
    return demoCatalogForScene(scene);
  },

  async load() {
    return read();
  },

  async saveUser(_user: AuthUser, profile: CurrentUser) {
    mutate((d) => ({ ...d, user: profile }));
  },
  async updateUser(_user: AuthUser, patch: Partial<CurrentUser>) {
    mutate((d) => (d.user ? { ...d, user: { ...d.user, ...patch } } : d));
  },
  async setAvailability(_user, availableUntil) {
    mutate((d) => d.user ? {
      ...d,
      user: { ...d.user, availableTonight: true, availableUntil },
    } : d);
  },
  async clearAvailability() {
    mutate((d) => d.user ? {
      ...d,
      user: { ...d.user, availableTonight: false, availableUntil: undefined },
    } : d);
  },
  async findAvailablePlayers(_user, selectedInstrument, maxDistanceMiles = 25) {
    const scene = read().user?.scene ?? "austin";
    return demoCatalogForScene(scene).players
      .filter((player) =>
        player.availableTonight
        && player.distanceMiles <= maxDistanceMiles
        && player.instruments.some(({ id }) => id === selectedInstrument),
      )
      .sort((a, b) => a.distanceMiles - b.distanceMiles || a.responseMins - b.responseMins)
      .map((player) => ({
        playerId: player.id,
        availableUntil: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        distanceMiles: player.distanceMiles,
      }));
  },
  async createSosBroadcast(_user, selectedInstrument, whenLabel) {
    const id = crypto.randomUUID();
    const profile = read().user;
    const recipients = demoCatalogForScene(profile?.scene ?? "austin").players.filter((player) =>
      player.availableTonight
      && player.distanceMiles <= 25
      && player.instruments.some(({ id: instrumentId }) => instrumentId === selectedInstrument),
    );
    localSosBroadcasts.set(id, {
      requesterName: profile?.name ?? "A local player",
      instrument: selectedInstrument,
      whenLabel,
      status: "open",
      expiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
    });
    return { broadcastId: id, recipientCount: recipients.length };
  },
  async getSosBroadcast(_user, broadcastId) {
    const broadcast = localSosBroadcasts.get(broadcastId);
    if (!broadcast) throw new Error("SOS broadcast was not found.");
    return {
      broadcastId,
      requesterId: "local-requester",
      requesterName: broadcast.requesterName,
      instrument: broadcast.instrument,
      whenLabel: broadcast.whenLabel,
      status: broadcast.status,
      expiresAt: broadcast.expiresAt,
      acceptedBy: broadcast.status === "matched" ? LOCAL_USER.id : null,
      canAccept: broadcast.status === "open",
    };
  },
  async acceptSosBroadcast(_user, broadcastId) {
    const broadcast = localSosBroadcasts.get(broadcastId);
    if (!broadcast || broadcast.status !== "open") {
      throw new Error("This SOS was already filled or expired.");
    }
    localSosBroadcasts.set(broadcastId, { ...broadcast, status: "matched" });
  },
  async uploadAvatar(_user: AuthUser, file: File) {
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Could not read that image."));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(file);
    });
  },
  async setFollow(_user: AuthUser, targetId: string, following: boolean) {
    mutate((d) => ({
      ...d,
      following: following
        ? d.following.includes(targetId)
          ? d.following
          : [...d.following, targetId]
        : d.following.filter((f) => f !== targetId),
    }));
  },
  async addMessage(_user: AuthUser, playerId: string, message: Message) {
    mutate((d) => ({
      ...d,
      conversations: upsertMessage(
        d.conversations,
        playerId,
        message,
        message.from === "them",
      ),
    }));
  },
  async markRead(_user: AuthUser, key: string) {
    // `key` is a playerId for DMs, or a conversation id for group chats
    mutate((d) => ({
      ...d,
      conversations: d.conversations.map((c) =>
        c.playerId === key || c.id === key ? { ...c, unread: 0 } : c,
      ),
    }));
  },
  async addBooking(_user: AuthUser, booking: Booking) {
    mutate((d) => ({ ...d, bookings: [...d.bookings, booking] }));
  },
  async setBookingStatus(_user: AuthUser, bookingId: string, status: BookingStatus) {
    mutate((d) => ({
      ...d,
      bookings: d.bookings.map((b) => (b.id === bookingId ? { ...b, status } : b)),
    }));
  },
  async submitBookingCheckIn(_user, bookingId, checkInId, file) {
    if (!file.type.startsWith("video/")) {
      throw new Error("Check-in recordings must be video files.");
    }
    if (file.size > 50 * 1024 * 1024) {
      throw new Error("Check-in recordings must be 50 MB or smaller.");
    }
    const recordingUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Could not read that recording."));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(file);
    });
    const current = read().bookings
      .find((booking) => booking.id === bookingId)
      ?.checkIns?.find((checkIn) => checkIn.id === checkInId);
    if (!current) throw new Error("Check-in was not found.");
    const checkIn: BookingCheckIn = {
      ...current,
      status: "submitted",
      recordingUrl,
      recordingName: file.name,
      submittedAt: new Date().toISOString(),
      reviewNote: undefined,
      reviewedAt: undefined,
    };
    mutate((data) => ({
      ...data,
      bookings: data.bookings.map((booking) => booking.id === bookingId ? {
        ...booking,
        checkIns: (booking.checkIns ?? []).map((item) => item.id === checkInId ? checkIn : item),
      } : booking),
    }));
    return checkIn;
  },
  async reviewBookingCheckIn(_user, bookingId, checkInId, status, note) {
    const current = read().bookings
      .find((booking) => booking.id === bookingId)
      ?.checkIns?.find((checkIn) => checkIn.id === checkInId);
    if (!current) throw new Error("Check-in was not found.");
    const checkIn: BookingCheckIn = {
      ...current,
      status,
      reviewNote: note?.trim() || undefined,
      reviewedAt: new Date().toISOString(),
    };
    mutate((data) => ({
      ...data,
      bookings: data.bookings.map((booking) => booking.id === bookingId ? {
        ...booking,
        checkIns: (booking.checkIns ?? []).map((item) => item.id === checkInId ? checkIn : item),
      } : booking),
    }));
    return checkIn;
  },
  async markNotificationRead(_user: AuthUser, notificationId: string) {
    mutate((d) => ({
      ...d,
      notifications: d.notifications.map((notification) =>
        notification.id === notificationId ? { ...notification, read: true } : notification,
      ),
    }));
  },
  async markAllNotificationsRead() {
    mutate((d) => ({
      ...d,
      notifications: d.notifications.map((notification) => ({ ...notification, read: true })),
    }));
  },
  async savePushSubscription() {
    // Push delivery is cloud-only.
  },
  async removePushSubscription() {
    // Push delivery is cloud-only.
  },
  async updateNotificationPreferences(_user: AuthUser, patch: Partial<NotificationPreferences>) {
    mutate((d) => ({
      ...d,
      notificationPreferences: { ...d.notificationPreferences, ...patch },
    }));
  },
  async createPayoutOnboardingLink() {
    throw new Error("Payout onboarding is available only with the cloud backend.");
  },
  async createBookingPaymentIntent() {
    throw new Error("Real payment setup is available only with the cloud backend.");
  },
  async fileBookingDispute(_user: AuthUser, bookingId: string, _reason: BookingDisputeReason) {
    mutate((d) => ({
      ...d,
      bookings: d.bookings.map((booking) => (
        booking.id === bookingId ? { ...booking, status: "disputed" } : booking
      )),
    }));
  },
  async cancelHeldBooking(_user: AuthUser, bookingId: string) {
    mutate((d) => ({
      ...d,
      bookings: d.bookings.map((booking) => (
        booking.id === bookingId ? { ...booking, status: "cancelled" } : booking
      )),
    }));
  },
  async addOpening(_user: AuthUser, opening: Opening) {
    mutate((d) => ({ ...d, openings: [opening, ...d.openings] }));
  },
  async setOpeningStatus(_user: AuthUser, openingId: string, status: Opening["status"]) {
    mutate((d) => ({
      ...d,
      openings: d.openings.map((o) => (o.id === openingId ? { ...o, status } : o)),
    }));
  },
  async upsertProject(_user: AuthUser, project: Band) {
    mutate((d) => ({
      ...d,
      projects: d.projects.some((p) => p.id === project.id)
        ? d.projects.map((p) => (p.id === project.id ? project : p))
        : [project, ...d.projects],
    }));
  },
  async upsertConversation(_user: AuthUser, conversation: Conversation) {
    mutate((d) => ({
      ...d,
      conversations: d.conversations.some((c) => c.id === conversation.id)
        ? d.conversations.map((c) => (c.id === conversation.id ? conversation : c))
        : [conversation, ...d.conversations],
    }));
  },
  async setLike(_user: AuthUser, postId: string, liked: boolean) {
    mutate((d) => ({
      ...d,
      likedPosts: liked
        ? d.likedPosts.includes(postId)
          ? d.likedPosts
          : [...d.likedPosts, postId]
        : d.likedPosts.filter((p) => p !== postId),
    }));
  },
  async addRespondedSub(_user: AuthUser, postId: string) {
    mutate((d) => ({
      ...d,
      respondedSubPosts: d.respondedSubPosts.includes(postId)
        ? d.respondedSubPosts
        : [...d.respondedSubPosts, postId],
    }));
  },
  async reset() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  },
};
