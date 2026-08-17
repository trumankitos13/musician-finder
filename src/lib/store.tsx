// App-wide state: current user, follows, conversations, bookings, likes.
//
// The reducer holds the authoritative in-memory state and updates
// OPTIMISTICALLY (synchronously) so the UI stays instant and reactive. Every
// mutation is then written through to the active backend (see src/lib/backend):
// localStorage in demo mode, or Supabase (auth + Postgres) when configured.
//
// Simulated replies / booking acceptances remain in local demo mode only.
// Cloud mode receives real participant updates through Supabase Realtime.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  Band,
  Booking,
  BookingCheckIn,
  BookingCheckInStatus,
  BookingDisputeReason,
  Conversation,
  CurrentUser,
  InstrumentId,
  Message,
  NotificationItem,
  NotificationPreferences,
  Opening,
} from "./types";
import { getPlayer, installCatalog, loadAndInstallCatalog, loadCatalogPersistAndReload } from "./data";
import { instrument, instrumentLabel } from "./instruments";
import { upsertMessage } from "./conversations";
import { scopePersistedData } from "./sceneScope";
import {
  backend,
  isCloudBackend,
  type AuthUser,
  type AvailabilityLocation,
  type AvailabilityMatch,
  type PersistedData,
  type SosBroadcastDetails,
  type SosBroadcastResult,
} from "./backend";
import type { AuthResult } from "./backend/types";
import {
  getBrowserPushSubscription,
  subscribeBrowserToPush,
} from "./push";
import { captureError } from "./observability";

export interface AppState {
  user: CurrentUser | null;
  /** followed band/venue ids */
  following: string[];
  conversations: Conversation[];
  bookings: Booking[];
  notifications: NotificationItem[];
  notificationPreferences: NotificationPreferences;
  likedPosts: string[];
  /** feed "need-sub" posts the user raised a hand on */
  respondedSubPosts: string[];
  /** post-gig star ratings the user has given, keyed by musician id (session-only) */
  ratingsGiven: Record<string, number[]>;
  /** openings the user posted, newest first */
  openings: Opening[];
  /** pickup projects / standing bands the user created (assemble flow) */
  projects: Band[];
}

const EMPTY_STATE: AppState = {
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
  ratingsGiven: {},
  openings: [],
  projects: [],
};

type Action =
  | { type: "HYDRATE"; data: PersistedData }
  | { type: "SET_USER"; user: CurrentUser }
  | { type: "UPDATE_USER"; patch: Partial<CurrentUser> }
  | { type: "TOGGLE_FOLLOW"; id: string }
  | { type: "SEND_MESSAGE"; playerId: string; message: Message }
  | { type: "RECEIVE_MESSAGE"; playerId: string; message: Message }
  | { type: "MARK_READ"; conversationId: string }
  | { type: "ADD_BOOKING"; booking: Booking }
  | { type: "SET_BOOKING_STATUS"; bookingId: string; status: Booking["status"] }
  | { type: "SET_BOOKING_CHECK_IN"; bookingId: string; checkIn: BookingCheckIn }
  | { type: "MARK_NOTIFICATION_READ"; notificationId: string }
  | { type: "MARK_ALL_NOTIFICATIONS_READ" }
  | { type: "UPDATE_NOTIFICATION_PREFERENCES"; patch: Partial<NotificationPreferences> }
  | { type: "TOGGLE_LIKE"; postId: string }
  | { type: "RESPOND_SUB"; postId: string }
  | { type: "RATE_MUSICIAN"; playerId: string; stars: number }
  | { type: "POST_OPENING"; opening: Opening }
  | { type: "SET_OPENING_STATUS"; openingId: string; status: Opening["status"] }
  | { type: "UPSERT_PROJECT"; project: Band }
  | { type: "UPSERT_CONVERSATION"; conversation: Conversation };

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "HYDRATE":
      return { ...EMPTY_STATE, ...scopePersistedData(action.data) };
    case "SET_USER":
      return { ...state, user: action.user };
    case "UPDATE_USER":
      return state.user
        ? scopePersistedData({ ...state, user: { ...state.user, ...action.patch } })
        : state;
    case "TOGGLE_FOLLOW":
      return {
        ...state,
        following: state.following.includes(action.id)
          ? state.following.filter((f) => f !== action.id)
          : [...state.following, action.id],
      };
    case "SEND_MESSAGE":
      return {
        ...state,
        conversations: upsertMessage(
          state.conversations,
          action.playerId,
          action.message,
          false,
        ),
      };
    case "RECEIVE_MESSAGE":
      return {
        ...state,
        conversations: upsertMessage(
          state.conversations,
          action.playerId,
          action.message,
          true,
        ),
      };
    case "MARK_READ":
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.id === action.conversationId ? { ...c, unread: 0 } : c,
        ),
      };
    case "ADD_BOOKING":
      return { ...state, bookings: [...state.bookings, action.booking] };
    case "SET_BOOKING_STATUS":
      return {
        ...state,
        bookings: state.bookings.map((b) =>
          b.id === action.bookingId ? { ...b, status: action.status } : b,
        ),
      };
    case "SET_BOOKING_CHECK_IN":
      return {
        ...state,
        bookings: state.bookings.map((booking) =>
          booking.id === action.bookingId
            ? {
                ...booking,
                checkIns: (booking.checkIns ?? []).map((checkIn) =>
                  checkIn.id === action.checkIn.id ? action.checkIn : checkIn,
                ),
              }
            : booking,
        ),
      };
    case "MARK_NOTIFICATION_READ":
      return {
        ...state,
        notifications: state.notifications.map((notification) =>
          notification.id === action.notificationId
            ? { ...notification, read: true }
            : notification,
        ),
      };
    case "MARK_ALL_NOTIFICATIONS_READ":
      return {
        ...state,
        notifications: state.notifications.map((notification) => ({
          ...notification,
          read: true,
        })),
      };
    case "UPDATE_NOTIFICATION_PREFERENCES":
      return {
        ...state,
        notificationPreferences: { ...state.notificationPreferences, ...action.patch },
      };
    case "TOGGLE_LIKE":
      return {
        ...state,
        likedPosts: state.likedPosts.includes(action.postId)
          ? state.likedPosts.filter((p) => p !== action.postId)
          : [...state.likedPosts, action.postId],
      };
    case "RESPOND_SUB":
      return state.respondedSubPosts.includes(action.postId)
        ? state
        : { ...state, respondedSubPosts: [...state.respondedSubPosts, action.postId] };
    case "RATE_MUSICIAN":
      return {
        ...state,
        ratingsGiven: {
          ...state.ratingsGiven,
          [action.playerId]: [
            ...(state.ratingsGiven[action.playerId] ?? []),
            action.stars,
          ],
        },
      };
    case "POST_OPENING":
      return { ...state, openings: [action.opening, ...state.openings] };
    case "SET_OPENING_STATUS":
      return {
        ...state,
        openings: state.openings.map((o) =>
          o.id === action.openingId ? { ...o, status: action.status } : o,
        ),
      };
    case "UPSERT_PROJECT":
      return {
        ...state,
        projects: state.projects.some((p) => p.id === action.project.id)
          ? state.projects.map((p) => (p.id === action.project.id ? action.project : p))
          : [action.project, ...state.projects],
      };
    case "UPSERT_CONVERSATION":
      return {
        ...state,
        conversations: state.conversations.some((c) => c.id === action.conversation.id)
          ? state.conversations.map((c) =>
              c.id === action.conversation.id ? action.conversation : c,
            )
          : [action.conversation, ...state.conversations],
      };
    default:
      return state;
  }
}

interface BookingOfferInput {
  playerId: string;
  gigTitle: string;
  venueName: string;
  date: string;
  time: string;
  gigAt?: string;
  amount: number;
  note?: string;
  /** when the offer is for a posted Opening — holding it locks that seat */
  openingId?: string;
  checkIns?: Array<Pick<BookingCheckIn, "dueAt" | "request">>;
}

interface CreateProjectInput {
  name: string;
  when: string;
  gigAt?: string;
  /** null = organizer only (writer/producer); else the creator takes a seat */
  playing: { instrument: InstrumentId } | null;
  /** one opening is posted per seat */
  seats: InstrumentId[];
  feePerSeat: number;
  note?: string;
}

/** deterministic avatar seed for user-created projects */
function seedFromId(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return 50 + h;
}

const GROUP_HELLOS = [
  "Hey all — locked in. Send charts when you have them 🙌",
  "In! What's the parking situation at the venue?",
  "Locked. I'll bring my own in-ears — who's running sound?",
  "Yo! Happy to be on this one. Setlist anywhere?",
];

const GROUP_REPLIES = [
  "Copy that 👍",
  "Works for me. See everyone at soundcheck.",
  "Can do. Anyone need a ride from the east side?",
  "🔥🔥",
  "On it — I'll post the setlist tonight.",
];

interface OpeningInput {
  instrument: Opening["instrument"];
  /** the "acting as" context (self / band you admin / venue you manage) */
  postedBy: Opening["postedBy"];
  when: string;
  /** canonical show time for persistence; the label remains the display fallback. */
  gigAt?: string;
  fee: number;
  note?: string;
  urgent?: boolean;
  eventId?: string;
}

export interface AppApi {
  /** send a chat message; local demo mode may add a canned reply */
  sendMessage(playerId: string, text: string, opts?: { simulateReply?: boolean }): void;
  /** send a booking offer into the thread */
  sendBookingOffer(input: BookingOfferInput): string;
  /** accept or decline an offer received by the signed-in player */
  respondToBooking(bookingId: string, status: "accepted" | "declined"): void;
  /** withdraw an outgoing offer or cancel an accepted booking */
  cancelBooking(bookingId: string): void;
  /** Upload the player's proof for one pre-show check-in. */
  submitBookingCheckIn(bookingId: string, checkInId: string, file: File): Promise<void>;
  /** Let the booker accept a take or request a replacement. */
  reviewBookingCheckIn(
    bookingId: string,
    checkInId: string,
    status: Extract<BookingCheckInStatus, "approved" | "changes_requested">,
    note?: string,
  ): Promise<void>;
  markNotificationRead(notificationId: string): void;
  markAllNotificationsRead(): void;
  enablePushNotifications(): Promise<void>;
  disablePushNotifications(): Promise<void>;
  updateNotificationPreferences(patch: Partial<NotificationPreferences>): void;
  /** create a Stripe-hosted payout onboarding link for the signed-in musician */
  startPayoutOnboarding(): Promise<string>;
  /** create or resume secure card authorization for an accepted booking */
  createBookingPaymentIntent(bookingId: string): Promise<string>;
  /** freeze a held payment while support reviews a participant dispute */
  fileBookingDispute(
    bookingId: string,
    reason: BookingDisputeReason,
    details: string,
  ): Promise<void>;
  /** cancel a held booking through the server-owned refund/late-fee policy */
  cancelHeldBooking(bookingId: string): Promise<void>;
  /** post an opening "acting as" a context; returns the opening id */
  postOpening(input: OpeningInput): string;
  /** assemble a pickup band: creates a project + one opening per seat */
  createProject(input: CreateProjectInput): string;
  /** record a "Stay as a group?" vote; promotes/archives when resolved */
  setStay(projectId: string, playerId: string, stay: "in" | "out"): void;
  /** send a message into a group chat; a roster member replies shortly */
  sendGroupMessage(conversationId: string, text: string): void;
  /** demo-only manual-capture stand-in — booking becomes "held" */
  holdBooking(bookingId: string, playerId: string): void;
  /** demo-only stand-in for the server's post-gig auto-release */
  releaseBooking(bookingId: string, playerId: string): void;
  toggleFollow(id: string): void;
  toggleLike(postId: string): void;
  /** record a post-gig star rating (1..5) for a musician (session-only) */
  rateMusician(playerId: string, stars: number): void;
  respondToSubPost(postId: string, bandName: string): void;
  markRead(conversationId: string): void;
  /** Persist onboarding before adopting the profile; rejects when the write fails. */
  setUser(user: CurrentUser): Promise<void>;
  updateUser(patch: Partial<CurrentUser>): Promise<void>;
  setAvailability(availableUntil: string, location?: AvailabilityLocation): Promise<void>;
  clearAvailability(): Promise<void>;
  findAvailablePlayers(
    instrument: InstrumentId,
    maxDistanceMiles?: number,
  ): Promise<AvailabilityMatch[]>;
  createSosBroadcast(
    instrument: InstrumentId,
    whenLabel: string,
    openingId?: string,
  ): Promise<SosBroadcastResult>;
  getSosBroadcast(broadcastId: string): Promise<SosBroadcastDetails>;
  acceptSosBroadcast(broadcastId: string): Promise<void>;
  uploadAvatar(file: File): Promise<string>;
  reset(): void;
  // auth (cloud mode)
  signIn(email: string, password: string): Promise<AuthResult>;
  signUp(email: string, password: string, name: string): Promise<AuthResult>;
  signOut(): Promise<void>;
  resetPassword(email: string): Promise<AuthResult>;
}

export type AuthStatus = "loading" | "signedOut" | "signedIn";
export interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
}

const AppContext = createContext<{
  state: AppState;
  api: AppApi;
  auth: AuthState;
} | null>(null);

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function nowLabel(): string {
  return new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

const CANNED_REPLIES = [
  "Hey! Just saw this — what's the date and the vibe?",
  "I'm interested! Send over the set list when you can 🎶",
  "Sounds fun. What's the load-in time?",
  "I'm around — tell me more about the room and the pay and I'm probably in.",
];

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, EMPTY_STATE);
  const [auth, setAuth] = useState<AuthState>({ status: "loading", user: null });

  // latest state + auth user, readable from stable api callbacks
  const stateRef = useRef(state);
  const authUserRef = useRef<AuthUser | null>(null);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // boot: resolve session, load data, and subscribe to auth changes
  useEffect(() => {
    let cancelled = false;
    let sawInitial = false;

    async function hydrateFor(user: AuthUser | null) {
      // catalog + user slice in parallel; the DB catalog (cloud mode) is
      // installed before hydrate renders anything. Local mode explicitly
      // supplies the built-in demo catalog; cloud mode always supplies an
      // account-backed catalog, even when that catalog is empty.
      const [guestCatalog, data] = await Promise.all([
        // Profiles load separately, so guest sessions must have a stable
        // default catalog until their saved scene is known.
        backend.loadCatalog("austin").catch((e) => {
          console.error("[backline] catalog load failed", e);
          return null;
        }),
        backend.load(user),
      ]);
      if (cancelled) return;
      const catalog = data.user?.scene && data.user.scene !== "austin"
          ? await backend.loadCatalog(data.user.scene).catch((e) => {
            console.error("[backline] scene catalog load failed — using Austin catalog", e);
            return guestCatalog;
          })
        : guestCatalog;
      if (cancelled) return;
      if (catalog) installCatalog(catalog);
      dispatch({ type: "HYDRATE", data });
    }

    (async () => {
      const sessionUser = await backend.getSession();
      if (cancelled) return;
      authUserRef.current = sessionUser;
      if (isCloudBackend && !sessionUser) {
        setAuth({ status: "signedOut", user: null });
        return;
      }
      await hydrateFor(sessionUser);
      if (cancelled) return;
      setAuth({ status: "signedIn", user: sessionUser });
    })();

    const unsubscribe = backend.onAuthChange((user) => {
      // supabase fires an INITIAL_SESSION event on subscribe; boot() above
      // already handled first load, so skip it.
      if (!sawInitial) {
        sawInitial = true;
        return;
      }
      authUserRef.current = user;
      if (!user) {
        dispatch({ type: "HYDRATE", data: EMPTY_STATE });
        setAuth({ status: "signedOut", user: null });
        return;
      }
      hydrateFor(user).then(() => setAuth({ status: "signedIn", user }));
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Cloud tables are the source of truth across devices. Rehydrate the
  // participant-scoped slice after a realtime message or booking change.
  useEffect(() => {
    if (auth.status !== "signedIn" || !auth.user) return;
    let timer: number | undefined;
    const user = auth.user;
    const unsubscribe = backend.subscribeToChanges(user, () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        backend.load(user)
          .then(async (data) => {
            const catalog = await backend.loadCatalog(data.user?.scene ?? "austin");
            if (catalog) installCatalog(catalog);
            dispatch({ type: "HYDRATE", data });
          })
          .catch((error) => console.error("[backline] realtime reload failed", error));
      }, 80);
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [auth.status, auth.user?.id]);

  const api = useMemo<AppApi>(() => {
    // Fire-and-forget write-through; errors reach optional release telemetry
    // as well as the console. The optimistic UI remains responsive.
    function persist(run: (user: AuthUser) => Promise<void>) {
      const user = authUserRef.current;
      if (!user) return;
      run(user).catch((error) => {
        captureError(error, { operation: "persist" });
        console.error("[backline] persist failed", error);
      });
    }

    function reload(): Promise<void> {
      const user = authUserRef.current;
      return backend.load(user)
        .then(async (data) => {
          const catalog = await backend.loadCatalog(data.user?.scene ?? "austin");
          if (catalog) installCatalog(catalog);
          dispatch({ type: "HYDRATE", data });
        })
        .catch((e) => console.error("[backline] reload failed", e));
    }

    return {
      sendMessage(playerId, text, opts) {
        const message: Message = { id: uid("m"), from: "me", text, at: nowLabel() };
        dispatch({ type: "SEND_MESSAGE", playerId, message });
        persist((u) => backend.addMessage(u, playerId, message));

        if (!isCloudBackend && opts?.simulateReply !== false) {
          const reply =
            CANNED_REPLIES[Math.floor(Math.random() * CANNED_REPLIES.length)];
          window.setTimeout(() => {
            const replyMsg: Message = {
              id: uid("m"),
              from: "them",
              text: reply,
              at: nowLabel(),
            };
            dispatch({ type: "RECEIVE_MESSAGE", playerId, message: replyMsg });
            persist((u) => backend.addMessage(u, playerId, replyMsg));
          }, 1800 + Math.random() * 1500);
        }
      },

      sendBookingOffer(input) {
        const bookingId = uid("bk");
        const booking: Booking = {
          id: bookingId,
          playerId: input.playerId,
          gigTitle: input.gigTitle,
          venueName: input.venueName,
          date: input.date,
          time: input.time,
          gigAt: input.gigAt,
          amount: input.amount,
          status: "offer",
          openingId: input.openingId,
          checkIns: input.checkIns?.map((checkIn) => ({
            id: uid("ci"),
            dueAt: checkIn.dueAt,
            request: checkIn.request,
            status: "requested" as const,
          })),
        };
        const noteMsg: Message | null = input.note
          ? { id: uid("m"), from: "me", text: input.note, at: nowLabel() }
          : null;
        const offerMsg: Message = { id: uid("m"), from: "me", bookingId, at: nowLabel() };

        dispatch({ type: "ADD_BOOKING", booking });
        if (noteMsg) {
          dispatch({ type: "SEND_MESSAGE", playerId: input.playerId, message: noteMsg });
        }
        dispatch({ type: "SEND_MESSAGE", playerId: input.playerId, message: offerMsg });

        // persist in FK-safe order: booking before the message that references it
        const user = authUserRef.current;
        if (user) {
          (async () => {
            await backend.addBooking(user, booking);
            if (noteMsg) await backend.addMessage(user, input.playerId, noteMsg);
            await backend.addMessage(user, input.playerId, offerMsg);
          })().catch((e) => console.error("[backline] persist offer failed", e));
        }

        if (!isCloudBackend) {
          // Keep the no-setup demo lively; cloud offers wait for the real
          // invited account to accept or decline.
          const name = getPlayer(input.playerId)?.name.split(" ")[0] ?? "They";
          window.setTimeout(() => {
            const acceptMsg: Message = {
              id: uid("m"),
              from: "them",
              text: `${name} here — I'm in! Accepted the offer. Hold the payment in the app to lock it and I'll see you at soundcheck. 🤘`,
              at: nowLabel(),
            };
            dispatch({ type: "SET_BOOKING_STATUS", bookingId, status: "accepted" });
            dispatch({ type: "RECEIVE_MESSAGE", playerId: input.playerId, message: acceptMsg });
            persist((u) => backend.setBookingStatus(u, bookingId, "accepted"));
            persist((u) => backend.addMessage(u, input.playerId, acceptMsg));
          }, 3500);
        }

        return bookingId;
      },

      respondToBooking(bookingId, status) {
        dispatch({ type: "SET_BOOKING_STATUS", bookingId, status });
        persist((user) => backend.setBookingStatus(user, bookingId, status));
      },

      cancelBooking(bookingId) {
        dispatch({ type: "SET_BOOKING_STATUS", bookingId, status: "cancelled" });
        persist((user) => backend.setBookingStatus(user, bookingId, "cancelled"));
      },

      async submitBookingCheckIn(bookingId, checkInId, file) {
        const user = authUserRef.current;
        if (!user) throw new Error("Sign in before submitting a check-in.");
        const checkIn = await backend.submitBookingCheckIn(user, bookingId, checkInId, file);
        dispatch({ type: "SET_BOOKING_CHECK_IN", bookingId, checkIn });
      },

      async reviewBookingCheckIn(bookingId, checkInId, status, note) {
        const user = authUserRef.current;
        if (!user) throw new Error("Sign in before reviewing a check-in.");
        const checkIn = await backend.reviewBookingCheckIn(
          user,
          bookingId,
          checkInId,
          status,
          note,
        );
        dispatch({ type: "SET_BOOKING_CHECK_IN", bookingId, checkIn });
      },

      markNotificationRead(notificationId) {
        dispatch({ type: "MARK_NOTIFICATION_READ", notificationId });
        persist((user) => backend.markNotificationRead(user, notificationId));
      },

      markAllNotificationsRead() {
        dispatch({ type: "MARK_ALL_NOTIFICATIONS_READ" });
        persist((user) => backend.markAllNotificationsRead(user));
      },

      async enablePushNotifications() {
        const user = authUserRef.current;
        if (!user) throw new Error("Sign in before enabling notifications.");
        const subscription = await subscribeBrowserToPush();
        await backend.savePushSubscription(
          user,
          subscription.toJSON(),
          navigator.userAgent,
          Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago",
        );
        dispatch({
          type: "UPDATE_NOTIFICATION_PREFERENCES",
          patch: { pushEnabled: true },
        });
      },

      async disablePushNotifications() {
        const user = authUserRef.current;
        if (!user) return;
        const subscription = await getBrowserPushSubscription();
        if (!subscription) return;
        await backend.removePushSubscription(user, subscription.endpoint);
        await subscription.unsubscribe();
        dispatch({
          type: "UPDATE_NOTIFICATION_PREFERENCES",
          patch: { pushEnabled: false },
        });
      },

      updateNotificationPreferences(patch) {
        dispatch({ type: "UPDATE_NOTIFICATION_PREFERENCES", patch });
        persist((user) => backend.updateNotificationPreferences(user, patch));
      },

      async startPayoutOnboarding() {
        const user = authUserRef.current;
        if (!user) throw new Error("Sign in before setting up payouts.");
        return backend.createPayoutOnboardingLink(user);
      },

      async createBookingPaymentIntent(bookingId) {
        const user = authUserRef.current;
        if (!user) throw new Error("Sign in before authorizing payment.");
        return backend.createBookingPaymentIntent(user, bookingId);
      },

      async fileBookingDispute(bookingId, reason, details) {
        const user = authUserRef.current;
        if (!user) throw new Error("Sign in before filing a dispute.");
        await backend.fileBookingDispute(user, bookingId, reason, details);
        dispatch({ type: "SET_BOOKING_STATUS", bookingId, status: "disputed" });
      },

      async cancelHeldBooking(bookingId) {
        const user = authUserRef.current;
        if (!user) throw new Error("Sign in before cancelling a booking.");
        await backend.cancelHeldBooking(user, bookingId);
        dispatch({ type: "SET_BOOKING_STATUS", bookingId, status: "cancelled" });
      },

      postOpening(input) {
        const id = uid("op");
        const opening: Opening = {
          id,
          scene: stateRef.current.user?.scene ?? "austin",
          instrument: input.instrument,
          postedBy: input.postedBy,
          when: input.when,
          gigAt: input.gigAt,
          fee: input.fee,
          note: input.note,
          urgent: input.urgent,
          eventId: input.eventId,
          status: "open",
          ago: "just now",
        };
        dispatch({ type: "POST_OPENING", opening });
        persist((u) => backend.addOpening(u, opening));
        return id;
      },

      createProject(input) {
        const projectId = uid("proj");
        const me = input.playing
          ? {
              playerId: "me",
              role: instrumentLabel(input.playing.instrument),
              admin: true,
              performing: true,
            }
          : { playerId: "me", role: "Organizer", admin: true, performing: false };
        const project: Band = {
          id: projectId,
          scene: stateRef.current.user?.scene ?? "austin",
          name: input.name,
          genres: [],
          bio: "",
          neighborhood: stateRef.current.user?.neighborhood ?? "",
          members: [me],
          openSlots: [],
          followers: 0,
          eventIds: [],
          kind: "project",
          ownerId: "me",
          seed: seedFromId(projectId),
        };
        dispatch({ type: "UPSERT_PROJECT", project });
        persist((u) => backend.upsertProject(u, project));

        // one opening per seat, posted by the project (fees private per seat)
        for (const seat of input.seats) {
          const opening: Opening = {
            id: uid("op"),
            scene: project.scene,
            instrument: seat,
            postedBy: { kind: "band", id: projectId },
            when: input.when,
            gigAt: input.gigAt,
            fee: input.feePerSeat,
            note: input.note,
            status: "open",
            ago: "just now",
          };
          dispatch({ type: "POST_OPENING", opening });
          persist((u) => backend.addOpening(u, opening));
        }
        return projectId;
      },

      holdBooking(bookingId, playerId) {
        dispatch({ type: "SET_BOOKING_STATUS", bookingId, status: "held" });
        persist((u) => backend.setBookingStatus(u, bookingId, "held"));

        // Seat fill: a booking tied to an opening locks that seat. If the
        // opening belongs to a project, the player joins the roster and the
        // group chat spins up on the first hold (docs/V1_SPEC.md). The system
        // line is public — the lock, never the fee.
        const booking = stateRef.current.bookings.find((b) => b.id === bookingId);
        const opening = booking?.openingId
          ? stateRef.current.openings.find((o) => o.id === booking.openingId)
          : undefined;
        const player = getPlayer(playerId);
        if (opening && opening.status === "open") {
          dispatch({ type: "SET_OPENING_STATUS", openingId: opening.id, status: "filled" });
          persist((u) => backend.setOpeningStatus(u, opening.id, "filled"));

          const project = stateRef.current.projects.find(
            (p) => p.id === opening.postedBy.id,
          );
          if (project && player) {
            const role = instrumentLabel(opening.instrument);
            const joined: Band = project.members.some((m) => m.playerId === playerId)
              ? project
              : {
                  ...project,
                  members: [
                    ...project.members,
                    { playerId, role, performing: true },
                  ],
                };
            dispatch({ type: "UPSERT_PROJECT", project: joined });
            persist((u) => backend.upsertProject(u, joined));

            const gid = `g-${project.id}`;
            const existing = stateRef.current.conversations.find((c) => c.id === gid);
            const lockLine: Message = {
              id: uid("m"),
              from: "them",
              system: true,
              text: `${instrument(opening.instrument).emoji} ${player.name} locked in on ${role.toLowerCase()}`,
              at: nowLabel(),
            };
            const seatsLeft = stateRef.current.openings.filter(
              (o) =>
                o.postedBy.id === project.id &&
                o.id !== opening.id &&
                o.status === "open",
            ).length;
            const lines: Message[] = [lockLine];
            if (seatsLeft === 0) {
              lines.push({
                id: uid("m"),
                from: "them",
                system: true,
                text: "🎉 Lineup complete — see everyone at soundcheck",
                at: nowLabel(),
              });
            }
            const convo: Conversation = existing
              ? {
                  ...existing,
                  participantIds: existing.participantIds?.includes(playerId)
                    ? existing.participantIds
                    : [...(existing.participantIds ?? ["me"]), playerId],
                  messages: [...existing.messages, ...lines],
                  unread: existing.unread + lines.length,
                }
              : {
                  id: gid,
                  kind: "group",
                  participantIds: ["me", playerId],
                  bandId: project.id,
                  title: project.name,
                  messages: [
                    {
                      id: uid("m"),
                      from: "them",
                      system: true,
                      text: `Group chat for ${project.name}. Fees stay in your 1:1 threads — only locks are public here.`,
                      at: nowLabel(),
                    },
                    ...lines,
                  ],
                  unread: lines.length + 1,
                };
            dispatch({ type: "UPSERT_CONVERSATION", conversation: convo });
            persist((u) => backend.upsertConversation(u, convo));

            // the freshly locked player says hi in the group after a beat
            window.setTimeout(() => {
              const cur = stateRef.current.conversations.find((c) => c.id === gid);
              if (!cur) return;
              const hi: Message = {
                id: uid("m"),
                from: "them",
                senderId: playerId,
                text: GROUP_HELLOS[Math.floor(Math.random() * GROUP_HELLOS.length)],
                at: nowLabel(),
              };
              const next = { ...cur, messages: [...cur.messages, hi], unread: cur.unread + 1 };
              dispatch({ type: "UPSERT_CONVERSATION", conversation: next });
              persist((u) => backend.upsertConversation(u, next));
            }, 2600);
          }
        }

        window.setTimeout(() => {
          const msg: Message = {
            id: uid("m"),
            from: "them",
            text: "Hold confirmed — you're locked in. 🔒 Sending you my stage plot now.",
            at: nowLabel(),
          };
          dispatch({ type: "RECEIVE_MESSAGE", playerId, message: msg });
          persist((u) => backend.addMessage(u, playerId, msg));
        }, 1500);
      },

      releaseBooking(bookingId, playerId) {
        dispatch({ type: "SET_BOOKING_STATUS", bookingId, status: "released" });
        persist((u) => backend.setBookingStatus(u, bookingId, "released"));
        window.setTimeout(() => {
          const msg: Message = {
            id: uid("m"),
            from: "them",
            text: "Payment landed — pleasure playing for you. Book me anytime. 🤝",
            at: nowLabel(),
          };
          dispatch({ type: "RECEIVE_MESSAGE", playerId, message: msg });
          persist((u) => backend.addMessage(u, playerId, msg));
        }, 1500);

        // Post-gig ready-check: once EVERY seat's booking for a project is
        // released, the "Stay as a group?" card goes live in the group chat
        // (game-lobby style — see docs/V1_SPEC.md). Simulated members vote in
        // after a beat; promotion waits for the owner's vote.
        const st = stateRef.current;
        const booking = st.bookings.find((b) => b.id === bookingId);
        const opening = booking?.openingId
          ? st.openings.find((o) => o.id === booking.openingId)
          : undefined;
        const project = opening
          ? st.projects.find((p) => p.id === opening.postedBy.id)
          : undefined;
        if (!project || project.kind !== "project" || project.archived) return;

        const projectOpeningIds = new Set(
          st.openings.filter((o) => o.postedBy.id === project.id).map((o) => o.id),
        );
        const seatBookings = st.bookings.filter(
          (b) => b.openingId && projectOpeningIds.has(b.openingId),
        );
        const noneOpen = st.openings.every(
          (o) => o.postedBy.id !== project.id || o.status !== "open",
        );
        const allReleased =
          seatBookings.length > 0 &&
          seatBookings.every((b) => b.id === bookingId || b.status === "released");
        if (!noneOpen || !allReleased) return;

        const gid = `g-${project.id}`;
        const cur = st.conversations.find((c) => c.id === gid);
        if (!cur) return;
        const wrap: Message = {
          id: uid("m"),
          from: "them",
          system: true,
          text: "🎉 That's a wrap — everyone's been paid. Stay as a group? Vote below.",
          at: nowLabel(),
        };
        const next = { ...cur, messages: [...cur.messages, wrap], unread: cur.unread + 1 };
        dispatch({ type: "UPSERT_CONVERSATION", conversation: next });
        persist((u) => backend.upsertConversation(u, next));

        // simulated members vote "in" on a stagger; the owner's vote decides
        project.members
          .filter((m) => m.playerId !== "me")
          .forEach((m, i) => {
            window.setTimeout(() => {
              const p = stateRef.current.projects.find((x) => x.id === project.id);
              if (!p || p.kind === "standing" || p.archived) return;
              const voted: Band = {
                ...p,
                members: p.members.map((mm) =>
                  mm.playerId === m.playerId ? { ...mm, stay: "in" as const } : mm,
                ),
              };
              dispatch({ type: "UPSERT_PROJECT", project: voted });
              persist((u) => backend.upsertProject(u, voted));
            }, 2200 + i * 1600);
          });
      },

      setStay(projectId, playerId, stay) {
        const p = stateRef.current.projects.find((x) => x.id === projectId);
        if (!p) return;
        let next: Band = {
          ...p,
          members: p.members.map((m) =>
            m.playerId === playerId ? { ...m, stay } : m,
          ),
        };

        const gid = `g-${projectId}`;
        const appendSystem = (text: string) => {
          const cur = stateRef.current.conversations.find((c) => c.id === gid);
          if (!cur) return;
          const line: Message = { id: uid("m"), from: "them", system: true, text, at: nowLabel() };
          const convo = { ...cur, messages: [...cur.messages, line], unread: cur.unread };
          dispatch({ type: "UPSERT_CONVERSATION", conversation: convo });
          persist((u) => backend.upsertConversation(u, convo));
        };

        // resolution rules (docs/V1_SPEC.md): the project becomes STANDING only
        // if the owner opts in AND at least one other member opts in; the
        // standing lineup = those who voted in. Owner out ⇒ archive.
        const ownerIn = next.members.some((m) => m.playerId === "me" && m.stay === "in");
        const othersIn = next.members.filter((m) => m.playerId !== "me" && m.stay === "in").length;
        if (playerId === "me" && stay === "out") {
          next = { ...next, archived: true };
          dispatch({ type: "UPSERT_PROJECT", project: next });
          persist((u) => backend.upsertProject(u, next));
          appendSystem(`📦 ${next.name} is archived — great gig, y'all.`);
          return;
        }
        if (ownerIn && othersIn >= 1) {
          next = {
            ...next,
            kind: "standing",
            members: next.members.filter((m) => m.stay === "in"),
          };
          dispatch({ type: "UPSERT_PROJECT", project: next });
          persist((u) => backend.upsertProject(u, next));
          appendSystem(`⭐ ${next.name} is now a standing band — it's in your "acting as" picker.`);
          return;
        }
        dispatch({ type: "UPSERT_PROJECT", project: next });
        persist((u) => backend.upsertProject(u, next));
      },

      sendGroupMessage(conversationId, text) {
        const cur = stateRef.current.conversations.find((c) => c.id === conversationId);
        if (!cur) return;
        const msg: Message = { id: uid("m"), from: "me", senderId: "me", text, at: nowLabel() };
        const next = { ...cur, messages: [...cur.messages, msg] };
        dispatch({ type: "UPSERT_CONVERSATION", conversation: next });
        persist((u) => backend.upsertConversation(u, next));

        const others = (cur.participantIds ?? []).filter((x) => x !== "me");
        if (others.length === 0) return;
        window.setTimeout(() => {
          const now = stateRef.current.conversations.find((c) => c.id === conversationId);
          if (!now) return;
          const senderId = others[Math.floor(Math.random() * others.length)];
          const reply: Message = {
            id: uid("m"),
            from: "them",
            senderId,
            text: GROUP_REPLIES[Math.floor(Math.random() * GROUP_REPLIES.length)],
            at: nowLabel(),
          };
          const bumped = { ...now, messages: [...now.messages, reply], unread: now.unread + 1 };
          dispatch({ type: "UPSERT_CONVERSATION", conversation: bumped });
          persist((u) => backend.upsertConversation(u, bumped));
        }, 1800 + Math.random() * 1600);
      },

      toggleFollow(id) {
        const willFollow = !stateRef.current.following.includes(id);
        dispatch({ type: "TOGGLE_FOLLOW", id });
        persist((u) => backend.setFollow(u, id, willFollow));
      },
      toggleLike(postId) {
        const willLike = !stateRef.current.likedPosts.includes(postId);
        dispatch({ type: "TOGGLE_LIKE", postId });
        persist((u) => backend.setLike(u, postId, willLike));
      },
      respondToSubPost(postId) {
        if (stateRef.current.respondedSubPosts.includes(postId)) return;
        dispatch({ type: "RESPOND_SUB", postId });
        persist((u) => backend.addRespondedSub(u, postId));
      },
      rateMusician(playerId, stars) {
        dispatch({ type: "RATE_MUSICIAN", playerId, stars });
      },
      markRead(conversationId) {
        const conv = stateRef.current.conversations.find((c) => c.id === conversationId);
        dispatch({ type: "MARK_READ", conversationId });
        if (!conv) return;
        // group chats persist as whole documents; DMs by playerId row
        if (conv.kind === "group") {
          persist((u) => backend.upsertConversation(u, { ...conv, unread: 0 }));
        } else if (conv.playerId) {
          const key = conv.playerId;
          persist((u) => backend.markRead(u, key));
        }
      },
      async setUser(user) {
        const authUser = authUserRef.current;
        if (!authUser) throw new Error("Sign in before creating a profile.");
        await backend.saveUser(authUser, user);
        dispatch({ type: "SET_USER", user });
      },
      async updateUser(patch) {
        dispatch({ type: "UPDATE_USER", patch });
        const user = authUserRef.current;
        if (patch.scene !== undefined) {
          if (!user) {
            await loadAndInstallCatalog(patch.scene, backend.loadCatalog.bind(backend));
            return;
          }
          await loadCatalogPersistAndReload({
            scene: patch.scene,
            loadCatalog: backend.loadCatalog.bind(backend),
            persist: () => backend.updateUser(user, patch),
            reload,
          });
          return;
        }
        if (!user) return;
        await backend.updateUser(user, patch);
        if (
          patch.name !== undefined ||
          patch.handle !== undefined ||
          patch.neighborhood !== undefined ||
          patch.availableTonight !== undefined ||
          patch.instruments !== undefined ||
          patch.bio !== undefined ||
          patch.genres !== undefined ||
          patch.gear !== undefined ||
          patch.availability !== undefined ||
          patch.rate !== undefined ||
          patch.reels !== undefined
        ) {
          const scene = stateRef.current.user?.scene ?? "austin";
          await loadAndInstallCatalog(scene, backend.loadCatalog.bind(backend));
        }
      },
      async setAvailability(availableUntil, location) {
        const user = authUserRef.current;
        if (!user) throw new Error("Sign in before setting availability.");
        await backend.setAvailability(user, availableUntil, location);
        dispatch({
          type: "UPDATE_USER",
          patch: { availableTonight: true, availableUntil },
        });
        await loadAndInstallCatalog(
          stateRef.current.user?.scene ?? "austin",
          backend.loadCatalog.bind(backend),
        );
      },
      async clearAvailability() {
        const user = authUserRef.current;
        if (!user) throw new Error("Sign in before changing availability.");
        await backend.clearAvailability(user);
        dispatch({
          type: "UPDATE_USER",
          patch: { availableTonight: false, availableUntil: undefined },
        });
      },
      async findAvailablePlayers(selectedInstrument, maxDistanceMiles) {
        const user = authUserRef.current;
        if (!user) return [];
        return backend.findAvailablePlayers(user, selectedInstrument, maxDistanceMiles);
      },
      async createSosBroadcast(selectedInstrument, whenLabel, openingId) {
        const user = authUserRef.current;
        if (!user) throw new Error("Sign in before sending an SOS.");
        return backend.createSosBroadcast(user, selectedInstrument, whenLabel, openingId, 25);
      },
      async getSosBroadcast(broadcastId) {
        const user = authUserRef.current;
        if (!user) throw new Error("Sign in to open this SOS.");
        return backend.getSosBroadcast(user, broadcastId);
      },
      async acceptSosBroadcast(broadcastId) {
        const user = authUserRef.current;
        if (!user) throw new Error("Sign in to accept this SOS.");
        await backend.acceptSosBroadcast(user, broadcastId);
      },
      async uploadAvatar(file) {
        const user = authUserRef.current;
        if (!user) throw new Error("Sign in before uploading an avatar.");
        const avatarUrl = await backend.uploadAvatar(user, file);
        dispatch({ type: "UPDATE_USER", patch: { avatarUrl } });
        const scene = stateRef.current.user?.scene ?? "austin";
        await loadAndInstallCatalog(scene, backend.loadCatalog.bind(backend));
        return avatarUrl;
      },
      reset() {
        const user = authUserRef.current;
        (async () => {
          if (user) await backend.reset(user);
          reload();
        })().catch((e) => console.error("[backline] reset failed", e));
      },

      signIn(email, password) {
        return backend.signIn(email, password);
      },
      signUp(email, password, name) {
        return backend.signUp(email, password, name);
      },
      async signOut() {
        const user = authUserRef.current;
        const subscription = await getBrowserPushSubscription().catch(() => null);
        if (user && subscription) {
          await backend.removePushSubscription(user, subscription.endpoint).catch((error) => {
            console.error("[backline] push cleanup failed", error);
          });
          await subscription.unsubscribe().catch(() => false);
        }
        await backend.signOut();
      },
      resetPassword(email) {
        return backend.resetPassword(email);
      },
    };
  }, []);

  // Keep badges and filters honest even when the app stays open past expiry;
  // Postgres already excludes the row, this clears the matching client state.
  useEffect(() => {
    const availableUntil = state.user?.availableUntil;
    if (!availableUntil) return;
    const remaining = new Date(availableUntil).getTime() - Date.now();
    if (remaining <= 0) {
      void api.clearAvailability().catch((error) => {
        console.error("[backline] expired availability cleanup failed", error);
      });
      return;
    }
    const timer = window.setTimeout(() => {
      void api.clearAvailability().catch((error) => {
        console.error("[backline] expired availability cleanup failed", error);
      });
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [api, state.user?.availableUntil]);

  return (
    <AppContext.Provider value={{ state, api, auth }}>{children}</AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside <AppProvider>");
  return ctx;
}

/** conversation for a musician, if any */
export function useConversationWith(playerId: string): Conversation | undefined {
  const { state } = useApp();
  return state.conversations.find((c) => c.playerId === playerId);
}

export function useUnreadCount(): number {
  const { state } = useApp();
  return state.conversations.reduce((n, c) => n + c.unread, 0);
}

export function useUnreadNotificationCount(): number {
  const { state } = useApp();
  return state.notifications.reduce((count, notification) => count + Number(!notification.read), 0);
}
