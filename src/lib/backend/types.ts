// The seam between the app and its data source. Two implementations exist:
//   * local.ts    — localStorage, no real auth (demo mode). Used when Supabase
//                   env vars are absent.
//   * supabase.ts — real Supabase Auth + Postgres. Used when configured.
// The store (store.tsx) talks only to this interface, so the rest of the app is
// unaware of which backend is live.

import type {
  Band,
  Booking,
  BookingCheckIn,
  BookingCheckInStatus,
  BookingDisputeReason,
  BookingStatus,
  Conversation,
  CurrentUser,
  Message,
  NotificationItem,
  NotificationPreferences,
  Opening,
} from "../types";
import type { Catalog } from "../data";
import type { SceneId } from "../scenes";

/** The per-user slice of state that gets persisted (catalog lives in data.ts). */
export interface PersistedData {
  user: CurrentUser | null;
  following: string[];
  conversations: Conversation[];
  bookings: Booking[];
  notifications: NotificationItem[];
  notificationPreferences: NotificationPreferences;
  likedPosts: string[];
  respondedSubPosts: string[];
  /** openings the user posted (newest first) — they lead the feed */
  openings: Opening[];
  /** pickup projects / standing bands the user created (assemble flow) */
  projects: Band[];
}

/** A minimal, backend-agnostic view of the signed-in account. */
export interface AuthUser {
  id: string;
  email: string | null;
}

export interface AuthResult {
  error: string | null;
  /** true when sign-up succeeded but the account still needs email confirmation */
  needsConfirmation?: boolean;
}

export interface AvailabilityLocation {
  latitude: number;
  longitude: number;
}

export interface AvailabilityMatch {
  playerId: string;
  availableUntil: string;
  /** Rounded by Postgres; exact player coordinates never leave the database. */
  distanceMiles: number | null;
}

export interface SosBroadcastResult {
  broadcastId: string;
  recipientCount: number;
}

export interface SosBroadcastDetails {
  broadcastId: string;
  requesterId: string;
  requesterName: string;
  instrument: CurrentUser["instruments"][number];
  whenLabel: string;
  status: "open" | "matched" | "expired" | "cancelled";
  expiresAt: string;
  acceptedBy: string | null;
  canAccept: boolean;
}

export interface Backend {
  readonly mode: "local" | "supabase";

  // --- auth ---
  /** current session, or null when signed out */
  getSession(): Promise<AuthUser | null>;
  /** react to sign-in / sign-out; returns an unsubscribe fn */
  onAuthChange(cb: (user: AuthUser | null) => void): () => void;
  signUp(email: string, password: string, name: string): Promise<AuthResult>;
  signIn(email: string, password: string): Promise<AuthResult>;
  signOut(): Promise<void>;
  /** send a password-reset email (no-op in local/demo mode) */
  resetPassword(email: string): Promise<AuthResult>;

  // --- data ---
  /**
   * Load the shared catalog (players/bands/venues/events/feed) for one scene.
   * Local mode returns the built-in demo catalog. Cloud mode returns public
   * account profiles and empty collections for unsupported hosted surfaces;
   * it never falls back to fictional catalog data.
   */
  loadCatalog(scene: SceneId): Promise<Catalog | null>;
  /** load everything persisted for `user` (or the demo default when local) */
  load(user: AuthUser | null): Promise<PersistedData>;
  /** subscribe to participant-scoped cloud changes; demo mode returns a no-op */
  subscribeToChanges(user: AuthUser, onChange: () => void): () => void;

  saveUser(user: AuthUser, profile: CurrentUser): Promise<void>;
  updateUser(user: AuthUser, patch: Partial<CurrentUser>): Promise<void>;
  setAvailability(
    user: AuthUser,
    availableUntil: string,
    location?: AvailabilityLocation,
  ): Promise<void>;
  clearAvailability(user: AuthUser): Promise<void>;
  findAvailablePlayers(
    user: AuthUser,
    instrument: CurrentUser["instruments"][number],
    maxDistanceMiles?: number,
  ): Promise<AvailabilityMatch[]>;
  createSosBroadcast(
    user: AuthUser,
    instrument: CurrentUser["instruments"][number],
    whenLabel: string,
    openingId?: string,
    maxDistanceMiles?: number,
  ): Promise<SosBroadcastResult>;
  getSosBroadcast(user: AuthUser, broadcastId: string): Promise<SosBroadcastDetails>;
  acceptSosBroadcast(user: AuthUser, broadcastId: string): Promise<void>;
  /** upload and persist the current user's avatar, returning its display URL */
  uploadAvatar(user: AuthUser, file: File): Promise<string>;
  setFollow(user: AuthUser, targetId: string, following: boolean): Promise<void>;
  addMessage(user: AuthUser, playerId: string, message: Message): Promise<void>;
  markRead(user: AuthUser, playerId: string): Promise<void>;
  addBooking(user: AuthUser, booking: Booking): Promise<void>;
  setBookingStatus(user: AuthUser, bookingId: string, status: BookingStatus): Promise<void>;
  /** Upload the invited player's check-in recording and mark it submitted. */
  submitBookingCheckIn(
    user: AuthUser,
    bookingId: string,
    checkInId: string,
    file: File,
  ): Promise<BookingCheckIn>;
  /** Approve a submitted check-in or ask the player for another take. */
  reviewBookingCheckIn(
    user: AuthUser,
    bookingId: string,
    checkInId: string,
    status: Extract<BookingCheckInStatus, "approved" | "changes_requested">,
    note?: string,
  ): Promise<BookingCheckIn>;
  markNotificationRead(user: AuthUser, notificationId: string): Promise<void>;
  markAllNotificationsRead(user: AuthUser): Promise<void>;
  savePushSubscription(
    user: AuthUser,
    subscription: PushSubscriptionJSON,
    userAgent: string,
    timezone: string,
  ): Promise<void>;
  removePushSubscription(user: AuthUser, endpoint: string): Promise<void>;
  updateNotificationPreferences(
    user: AuthUser,
    patch: Partial<NotificationPreferences>,
  ): Promise<void>;
  /** create a short-lived Stripe-hosted payout onboarding link */
  createPayoutOnboardingLink(user: AuthUser): Promise<string>;
  /** create or resume the server-owned PaymentIntent for an accepted booking */
  createBookingPaymentIntent(user: AuthUser, bookingId: string): Promise<string>;
  /** freeze an eligible hold while support reviews a participant's dispute */
  fileBookingDispute(
    user: AuthUser,
    bookingId: string,
    reason: BookingDisputeReason,
    details: string,
  ): Promise<void>;
  /** apply the server-owned cancellation policy to a held Stripe payment */
  cancelHeldBooking(user: AuthUser, bookingId: string): Promise<void>;
  addOpening(user: AuthUser, opening: Opening): Promise<void>;
  setOpeningStatus(user: AuthUser, openingId: string, status: Opening["status"]): Promise<void>;
  /** create-or-replace a user project (assemble / roster / ready-check updates) */
  upsertProject(user: AuthUser, project: Band): Promise<void>;
  /** create-or-replace a whole conversation (group chats mutate membership + system lines) */
  upsertConversation(user: AuthUser, conversation: Conversation): Promise<void>;
  setLike(user: AuthUser, postId: string, liked: boolean): Promise<void>;
  addRespondedSub(user: AuthUser, postId: string): Promise<void>;
  reset(user: AuthUser): Promise<void>;
}
