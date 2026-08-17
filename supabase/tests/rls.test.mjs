// Row-Level-Security isolation tests for Backline.
//
// Proves the policies in supabase/migrations/*_rls_policies.sql actually hold:
//   - catalog is publicly readable but not publicly writable
//   - every per-user table isolates rows to their owner (A cannot read, update,
//     or forge B's data)
//
// Requires a *disposable* Supabase project (never point this at production — it
// creates and deletes users). Set:
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// Run:  node supabase/tests/rls.test.mjs
// Exits non-zero on any failure. See supabase/tests/README.md.

import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL || !ANON || !SERVICE) {
  console.error("Missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}

// ---- tiny assertion harness ----
let passed = 0;
const failures = [];
function check(name, cond) {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(name);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m`);
  }
}

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const anon = createClient(URL, ANON, { auth: { persistSession: false } });

/** create a confirmed user and return an authed client + id. */
async function makeUser(tag) {
  const email = `rls-test-${tag}-${Date.now()}@backline.test`;
  const password = "test-password-123!";
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name: `RLS ${tag}` },
  });
  if (error) throw new Error(`createUser(${tag}): ${error.message}`);
  const client = createClient(URL, ANON, { auth: { persistSession: false } });
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password });
  if (signInErr) throw new Error(`signIn(${tag}): ${signInErr.message}`);
  return { id: data.user.id, client, email };
}

async function main() {
  console.log("\n\x1b[1mBackline RLS isolation tests\x1b[0m\n");

  // A catalog musician id is needed for FK-constrained inserts (bookings, convos)
  const { data: musicians, error: catErr } = await anon.from("musicians").select("id").limit(1);
  if (catErr) throw new Error(`catalog read: ${catErr.message}`);
  if (!musicians?.length) {
    throw new Error("Catalog is empty — run supabase/seed.sql before the RLS tests.");
  }
  const musicianId = musicians[0].id;

  const { data: scenes, error: scenesErr } = await admin
    .from("musicians")
    .select("scene")
    .in("scene", ["austin", "nashville"]);
  check("catalog contains Austin and Nashville", !scenesErr && new Set(scenes.map((row) => row.scene)).size === 2);

  console.log("catalog (anon / signed-out):");
  check("anon CAN read catalog (musicians)", musicians.length > 0);
  const anonWrite = await anon.from("musicians").insert({ id: `hack-${Date.now()}`, name: "x", handle: `h${Date.now()}` });
  check("anon CANNOT write catalog", anonWrite.error !== null);

  // Phase 0 parity: the DB-backed catalog carries the 4-object refactor fields
  // (proves both the parity migration AND the regenerated seed are applied).
  const parity = await Promise.all([
    anon.from("musicians").select("links").eq("id", "m-dre").single(),
    anon.from("venues").select("backline, hiring").eq("id", "v-armadillo").single(),
    anon.from("gigs").select("description, sub_needed").eq("id", "e-cedarrye-rattlesnake").single(),
    anon.from("band_members").select("admin").eq("musician_id", "m-ada").single(),
  ]);
  check("catalog parity: musician links seeded", !parity[0].error && parity[0].data?.links != null);
  check("catalog parity: venue backline + hiring seeded", !parity[1].error && parity[1].data?.backline != null);
  check("catalog parity: event description + sub_needed seeded", !parity[2].error && parity[2].data?.description != null && parity[2].data?.sub_needed != null);
  check("catalog parity: band admin flag seeded", !parity[3].error && parity[3].data?.admin === true);

  const A = await makeUser("a");
  const B = await makeUser("b");
  const C = await makeUser("c");
  const profileStamp = Date.now();
  const completedProfiles = await Promise.all([
    A.client.from("profiles").update({ handle: `rls_a_${profileStamp}`, instruments: ["guitar"] }).eq("id", A.id),
    B.client.from("profiles").update({ handle: `rls_b_${profileStamp}`, instruments: ["drums"] }).eq("id", B.id),
    C.client.from("profiles").update({ handle: `rls_c_${profileStamp}`, instruments: ["bass"] }).eq("id", C.id),
  ]);
  check("test accounts can complete valid public profiles", completedProfiles.every((result) => !result.error));

  // Phase 4: raw availability (including optional exact location) is owner-only,
  // while the matcher returns only same-scene active profile ids + coarse distance.
  const availabilityUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const bAvailability = await B.client.rpc("set_my_availability", {
    p_available_until: availabilityUntil,
    p_latitude: 30.2672,
    p_longitude: -97.7431,
  });
  check("B can create an expiring private availability window", !bAvailability.error);

  const [bOwnAvailability, aReadsBAvailability, anonReadsAvailability] = await Promise.all([
    B.client.from("player_availability").select("user_id,available_until").eq("user_id", B.id),
    A.client.from("player_availability").select("user_id,location").eq("user_id", B.id),
    anon.from("player_availability").select("user_id"),
  ]);
  check("B can read their own availability", bOwnAvailability.data?.length === 1);
  check("A cannot read B's coordinates", !aReadsBAvailability.error && aReadsBAvailability.data?.length === 0);
  check("anon cannot read availability", anonReadsAvailability.error !== null);

  const aFindsDrummer = await A.client.rpc("find_available_players", {
    p_instrument: "drums",
    p_max_distance_miles: 25,
  });
  check(
    "same-scene matcher finds active B without exposing coordinates",
    !aFindsDrummer.error
      && aFindsDrummer.data?.some((row) => row.profile_id === B.id)
      && aFindsDrummer.data?.every((row) => !("location" in row)),
  );

  const anonFind = await anon.rpc("find_available_players", {
    p_instrument: "drums",
    p_max_distance_miles: 25,
  });
  check("anon cannot call availability matcher", anonFind.error !== null);
  const privateFind = await A.client.schema("private").rpc("find_available_players", {
    p_instrument: "drums",
    p_max_distance_miles: 25,
  });
  check("privileged matcher implementation is not Data API exposed", privateFind.error !== null);

  const sosCreated = await A.client.rpc("create_sos_broadcast", {
    p_instrument: "drums",
    p_when_label: "Tonight at 9:00 PM",
    p_max_distance_miles: 25,
  });
  const sosId = sosCreated.data?.[0]?.broadcast_id;
  check(
    "A can broadcast only to live matching players",
    !sosCreated.error && Boolean(sosId) && sosCreated.data?.[0]?.recipient_count === 1,
  );

  const [bLoadsSos, cLoadsSos, anonLoadsSos] = await Promise.all([
    B.client.rpc("get_sos_broadcast", { p_broadcast_id: sosId }),
    C.client.rpc("get_sos_broadcast", { p_broadcast_id: sosId }),
    anon.rpc("get_sos_broadcast", { p_broadcast_id: sosId }),
  ]);
  check("notified B can open the SOS", !bLoadsSos.error && bLoadsSos.data?.[0]?.can_accept === true);
  check("unmatched C cannot inspect the SOS", cLoadsSos.error !== null);
  check("anon cannot inspect the SOS", anonLoadsSos.error !== null);

  const bAcceptsSos = await B.client.rpc("accept_sos_broadcast", { p_broadcast_id: sosId });
  const bAcceptsTwice = await B.client.rpc("accept_sos_broadcast", { p_broadcast_id: sosId });
  check("B can atomically accept the SOS", !bAcceptsSos.error);
  check("the same SOS cannot be accepted twice", bAcceptsTwice.error !== null);

  const matchedSos = await admin.from("sos_broadcasts").select("status,accepted_by").eq("id", sosId).single();
  const requesterSosAlert = await A.client.from("notifications").select("kind").eq("kind", "sos_accepted");
  check("first acceptance locks the broadcast to B", matchedSos.data?.status === "matched" && matchedSos.data?.accepted_by === B.id);
  check("requester receives a durable SOS match alert", requesterSosAlert.data?.length === 1);
  console.log("\nseeding user A's private data:");

  // A writes a full set of owned rows
  const bookingId = `bk-rls-${Date.now()}`;
  const openingId = `op-rls-${Date.now()}`;
  const seedA = await Promise.all([
    A.client.from("follows").insert({ user_id: A.id, target_id: "b-moontower" }),
    A.client.from("bookings").insert({ id: bookingId, user_id: A.id, musician_id: musicianId, gig_title: "Secret gig", amount: 150, status: "offer" }),
    A.client.from("liked_posts").insert({ user_id: A.id, post_id: "p-1" }),
    A.client.from("responded_sub_posts").insert({ user_id: A.id, post_id: "p-1" }),
    // fee lives on this row — its privacy is exactly what these tests protect
    A.client.from("openings").insert({ id: openingId, user_id: A.id, instrument: "drums", posted_by_kind: "player", posted_by_id: "me", when_label: "Tonight", fee: 150 }),
    // projects + group chats persist as whole documents (Phase 0)
    A.client.from("user_projects").insert({ id: `proj-rls-${Date.now()}`, user_id: A.id, data: { id: "proj-x", name: "Secret Project", members: [] } }),
    A.client.from("group_conversations").insert({ id: `g-rls-${Date.now()}`, user_id: A.id, data: { id: "g-x", kind: "group", messages: [], unread: 0 } }),
  ]);
  check("A can write its own follows/bookings/likes/subs/openings/projects/group-chats", seedA.every((r) => !r.error));

  const convIns = await A.client.from("conversations").insert({ user_id: A.id, musician_id: musicianId }).select("id").single();
  check("A can create its own conversation", !convIns.error);
  const convId = convIns.data?.id;
  const msgIns = await A.client.from("messages").insert({ id: `m-rls-${Date.now()}`, conversation_id: convId, sender: "user", body: "secret" });
  check("A can post a message in its own conversation", !msgIns.error);

  // Phase 2: a canonical account-to-account conversation is visible only to
  // its two participants, and sending a message creates B's durable alert.
  const [participantA, participantB] = [A.id, B.id].sort();
  const directConvIns = await A.client.from("direct_conversations").insert({
    participant_a: participantA,
    participant_b: participantB,
  }).select("id").single();
  check("A can create a direct conversation with B", !directConvIns.error);
  const directConvId = directConvIns.data?.id;
  const directMessageId = `dm-rls-${Date.now()}`;
  const directMsgIns = await A.client.from("direct_messages").insert({
    id: directMessageId,
    conversation_id: directConvId,
    sender_id: A.id,
    body: "participant secret",
  });
  check("A can send B a real direct message", !directMsgIns.error);
  const bDirectRead = await B.client.from("direct_messages").select("id").eq("id", directMessageId);
  const cDirectRead = await C.client.from("direct_messages").select("id").eq("id", directMessageId);
  check("B can read their direct message", (bDirectRead.data?.length ?? 0) === 1);
  check("C cannot read A and B's direct message", !cDirectRead.error && (cDirectRead.data?.length ?? 0) === 0);

  const realBookingId = `bk-real-${Date.now()}`;
  const realBooking = await A.client.from("bookings").insert({
    id: realBookingId,
    user_id: A.id,
    musician_id: B.id,
    musician_user_id: B.id,
    gig_title: "Real two-party gig",
    amount: 200,
    status: "offer",
  });
  check("A can send B a real booking offer", !realBooking.error);

  // Booking check-ins are part of the offer terms, visible only to the two
  // participants, and their private recordings have role-specific writes.
  const checkInBookingId = `bk-check-in-${Date.now()}`;
  const checkInId = `ci-rls-${Date.now()}`;
  const checkInGigAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const checkInDueAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  const checkInOffer = await A.client.rpc("create_booking_offer_with_check_ins", {
    p_id: checkInBookingId,
    p_musician_user_id: B.id,
    p_gig_title: "Check-in test gig",
    p_venue_name: "RLS Room",
    p_date: "Next week",
    p_time: "9:00 PM",
    p_gig_at: checkInGigAt,
    p_amount: 225,
    p_opening_id: null,
    p_check_ins: [{
      id: checkInId,
      due_at: checkInDueAt,
      request: "Play the bridge and final chorus.",
    }],
  });
  check("booker can atomically create an offer with check-ins", !checkInOffer.error);

  const [aCheckInRead, bCheckInRead, cCheckInRead] = await Promise.all([
    A.client.from("booking_check_ins").select("id,status").eq("id", checkInId),
    B.client.from("booking_check_ins").select("id,status").eq("id", checkInId),
    C.client.from("booking_check_ins").select("id,status").eq("id", checkInId),
  ]);
  check("both booking participants can read a check-in", aCheckInRead.data?.length === 1 && bCheckInRead.data?.length === 1);
  check("nonparticipant cannot read a check-in", !cCheckInRead.error && cCheckInRead.data?.length === 0);

  const recordingPath = `${checkInBookingId}/${checkInId}/${B.id}/rls-proof.mp4`;
  const earlyUpload = await B.client.storage.from("booking-check-ins").upload(
    recordingPath,
    new Blob(["video"], { type: "video/mp4" }),
    { contentType: "video/mp4" },
  );
  check("player cannot upload proof before accepting the offer", earlyUpload.error !== null);

  const checkInAccept = await B.client.from("bookings")
    .update({ status: "accepted" }).eq("id", checkInBookingId);
  check("player can accept an offer carrying check-ins", !checkInAccept.error);

  const strangerUpload = await C.client.storage.from("booking-check-ins").upload(
    `${checkInBookingId}/${checkInId}/${C.id}/forged.mp4`,
    new Blob(["video"], { type: "video/mp4" }),
    { contentType: "video/mp4" },
  );
  check("nonparticipant cannot upload check-in proof", strangerUpload.error !== null);

  const playerUpload = await B.client.storage.from("booking-check-ins").upload(
    recordingPath,
    new Blob(["video"], { type: "video/mp4" }),
    { contentType: "video/mp4" },
  );
  check("accepted player can upload private check-in proof", !playerUpload.error);

  const forgedPlayerSubmit = await A.client.from("booking_check_ins").update({
    status: "submitted",
    recording_path: recordingPath,
    recording_name: "rls-proof.mp4",
  }).eq("id", checkInId);
  check("booker cannot submit proof on the player's behalf", forgedPlayerSubmit.error !== null);

  const playerSubmit = await B.client.from("booking_check_ins").update({
    status: "submitted",
    recording_path: recordingPath,
    recording_name: "rls-proof.mp4",
  }).eq("id", checkInId).select("status").single();
  check("player can submit their uploaded check-in proof", playerSubmit.data?.status === "submitted");

  const forgedReview = await B.client.from("booking_check_ins")
    .update({ status: "approved" }).eq("id", checkInId);
  check("player cannot approve their own check-in", forgedReview.error !== null);

  const [bookerRecording, strangerRecording] = await Promise.all([
    A.client.storage.from("booking-check-ins").createSignedUrl(recordingPath, 60),
    C.client.storage.from("booking-check-ins").createSignedUrl(recordingPath, 60),
  ]);
  check("booker can create a signed URL for participant proof", !bookerRecording.error && Boolean(bookerRecording.data?.signedUrl));
  check("nonparticipant cannot sign participant proof", strangerRecording.error !== null);

  const bookerReview = await A.client.from("booking_check_ins")
    .update({ status: "approved", review_note: "Locked in." })
    .eq("id", checkInId).select("status,reviewed_at").single();
  check("booker can approve a submitted check-in", bookerReview.data?.status === "approved" && Boolean(bookerReview.data?.reviewed_at));

  await A.client.from("bookings").update({ status: "accepted" }).eq("id", realBookingId);
  const afterWrongActor = await admin.from("bookings").select("status").eq("id", realBookingId).single();
  check("booker cannot accept their own offer", afterWrongActor.data?.status === "offer");

  const bAccept = await B.client.from("bookings").update({ status: "accepted" }).eq("id", realBookingId).select("status").single();
  check("only invited player B can accept the offer", bAccept.data?.status === "accepted");

  await B.client.from("bookings").update({ status: "held" }).eq("id", realBookingId);
  const afterWrongHolder = await admin.from("bookings").select("status").eq("id", realBookingId).single();
  check("invited player cannot place the payment hold", afterWrongHolder.data?.status === "accepted");

  await A.client.from("bookings").update({ status: "held" }).eq("id", realBookingId);
  const afterBookerHold = await admin.from("bookings").select("status").eq("id", realBookingId).single();
  check("booker cannot forge a payment hold", afterBookerHold.data?.status === "accepted");

  const serverHold = await admin.from("bookings").update({ status: "held" }).eq("id", realBookingId).select("status").single();
  check("payment service can confirm a hold", serverHold.data?.status === "held");

  await B.client.from("bookings").update({ status: "released" }).eq("id", realBookingId);
  const afterWrongRelease = await admin.from("bookings").select("status").eq("id", realBookingId).single();
  check("invited player cannot release the demo payment", afterWrongRelease.data?.status === "held");

  await A.client.from("bookings").update({ status: "released" }).eq("id", realBookingId);
  const afterBookerRelease = await admin.from("bookings").select("status").eq("id", realBookingId).single();
  check("booker cannot forge a payment release", afterBookerRelease.data?.status === "held");

  const serverRelease = await admin.from("bookings").update({ status: "released" }).eq("id", realBookingId).select("status").single();
  check("payment service can confirm a release", serverRelease.data?.status === "released");

  // Phase 3 foundation: clients can read only their safe payment status and
  // payout-readiness columns. Stripe ids and all writes remain server-only.
  const paymentStamp = Date.now();
  const paymentSeed = await admin.from("booking_payments").insert({
    booking_id: realBookingId,
    payer_id: A.id,
    payee_id: B.id,
    currency: "usd",
    musician_amount_cents: 20000,
    service_fee_cents: 2000,
    total_amount_cents: 22000,
    status: "pending",
  }).select("id").single();
  check("server can create a payment record", !paymentSeed.error);

  const connectSeed = await admin.from("connected_accounts").insert({
    user_id: B.id,
    stripe_account_id: `acct_Rls${paymentStamp}`,
    details_submitted: true,
    charges_enabled: true,
    payouts_enabled: true,
  });
  check("server can record connected-account readiness", !connectSeed.error);

  const [aPayment, bPayment, cPayment] = await Promise.all([
    A.client.from("booking_payments").select("booking_id,status,total_amount_cents").eq("booking_id", realBookingId),
    B.client.from("booking_payments").select("booking_id,status,total_amount_cents").eq("booking_id", realBookingId),
    C.client.from("booking_payments").select("booking_id,status,total_amount_cents").eq("booking_id", realBookingId),
  ]);
  check("booker can read safe payment status", !aPayment.error && aPayment.data?.length === 1);
  check("musician can read safe payment status", !bPayment.error && bPayment.data?.length === 1);
  check("nonparticipant cannot read payment status", !cPayment.error && cPayment.data?.length === 0);

  const hiddenStripeId = await B.client.from("connected_accounts").select("stripe_account_id").eq("user_id", B.id);
  check("client cannot select the connected Stripe account id", hiddenStripeId.error !== null);
  const forgedPayment = await A.client.from("booking_payments").insert({
    booking_id: realBookingId,
    payer_id: A.id,
    payee_id: B.id,
    musician_amount_cents: 1,
    service_fee_cents: 0,
    total_amount_cents: 1,
  });
  check("client cannot create payment records", forgedPayment.error !== null);
  const forgedReadiness = await B.client.from("connected_accounts").update({ payouts_enabled: true }).eq("user_id", B.id);
  check("client cannot forge payout readiness", forgedReadiness.error !== null);
  const forgedCaptureClaim = await A.client.rpc("claim_due_booking_payments", { batch_size: 1 });
  check("client cannot invoke the scheduled capture claim", forgedCaptureClaim.error !== null);

  // A held payment may be disputed by either participant through the narrow
  // insert policy. The trigger freezes both state machines atomically; a
  // stranger and a duplicate open dispute both fail closed.
  const disputeBookingId = `bk-dispute-${Date.now()}`;
  const gigAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const disputeOffer = await A.client.from("bookings").insert({
    id: disputeBookingId,
    user_id: A.id,
    musician_id: B.id,
    musician_user_id: B.id,
    gig_title: "Disputed test gig",
    date: "Today",
    time: "Soon",
    gig_at: gigAt,
    amount: 175,
    status: "offer",
  });
  const disputeAccept = await B.client.from("bookings")
    .update({ status: "accepted" }).eq("id", disputeBookingId);
  const disputeHold = await admin.from("bookings")
    .update({ status: "held" }).eq("id", disputeBookingId);
  const disputePayment = await admin.from("booking_payments").insert({
    booking_id: disputeBookingId,
    payer_id: A.id,
    payee_id: B.id,
    stripe_payment_intent_id: `pi_Rls${Date.now()}`,
    currency: "usd",
    musician_amount_cents: 17500,
    service_fee_cents: 1750,
    total_amount_cents: 19250,
    status: "held",
    authorization_expires_at: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString(),
  }).select("id").single();
  check(
    "server can prepare a held booking for dispute testing",
    !disputeOffer.error && !disputeAccept.error && !disputeHold.error && !disputePayment.error,
  );

  const strangerDispute = await C.client.from("booking_disputes").insert({
    booking_id: disputeBookingId,
    filed_by: C.id,
    reason: "other",
    details: "not a participant",
  });
  check("nonparticipant cannot file a booking dispute", strangerDispute.error !== null);

  const participantDispute = await B.client.from("booking_disputes").insert({
    booking_id: disputeBookingId,
    filed_by: B.id,
    reason: "no_show",
    details: "RLS freeze test",
  }).select("id").single();
  check("participant can file a timely dispute", !participantDispute.error);

  const [frozenBooking, frozenPayment, aDisputeRead, bDisputeRead, cDisputeRead] = await Promise.all([
    admin.from("bookings").select("status").eq("id", disputeBookingId).single(),
    admin.from("booking_payments").select("status").eq("booking_id", disputeBookingId).single(),
    A.client.from("booking_disputes").select("id").eq("booking_id", disputeBookingId),
    B.client.from("booking_disputes").select("id").eq("booking_id", disputeBookingId),
    C.client.from("booking_disputes").select("id").eq("booking_id", disputeBookingId),
  ]);
  check("dispute atomically freezes booking and payment", frozenBooking.data?.status === "disputed" && frozenPayment.data?.status === "disputed");
  check("both booking participants can read the dispute", aDisputeRead.data?.length === 1 && bDisputeRead.data?.length === 1);
  check("nonparticipant cannot read the dispute", !cDisputeRead.error && cDisputeRead.data?.length === 0);

  const duplicateDispute = await A.client.from("booking_disputes").insert({
    booking_id: disputeBookingId,
    filed_by: A.id,
    reason: "quality",
    details: "duplicate open case",
  });
  check("participants cannot open a duplicate dispute", duplicateDispute.error !== null);

  const forgedResolution = await A.client.rpc("resolve_booking_dispute", {
    dispute_id: participantDispute.data?.id,
    resolution: "refund",
    resolution_note: "client must not resolve",
    stripe_refund_id: `re_RlsForged${Date.now()}`,
  });
  check("participant cannot resolve their own dispute", forgedResolution.error !== null);

  const refundId = `re_Rls${Date.now()}`;
  const serverResolution = await admin.rpc("resolve_booking_dispute", {
    dispute_id: participantDispute.data?.id,
    resolution: "refund",
    resolution_note: "Disposable-project resolution test",
    stripe_refund_id: refundId,
  });
  const [resolvedDispute, refundedBooking, refundedPayment, refundNotice] = await Promise.all([
    admin.from("booking_disputes").select("status,resolved_at").eq("id", participantDispute.data?.id).single(),
    admin.from("bookings").select("status").eq("id", disputeBookingId).single(),
    admin.from("booking_payments").select("status,stripe_refund_id").eq("booking_id", disputeBookingId).single(),
    A.client.from("notifications").select("kind").eq("kind", "payment_refunded").eq("recipient_id", A.id),
  ]);
  check("payment service can atomically resolve a refund", !serverResolution.error && resolvedDispute.data?.status === "resolved_refund" && refundedBooking.data?.status === "refunded" && refundedPayment.data?.status === "refunded" && refundedPayment.data?.stripe_refund_id === refundId);
  check("booker receives a durable refund notification", refundNotice.data?.length === 1);

  const repeatedResolution = await admin.rpc("resolve_booking_dispute", {
    dispute_id: participantDispute.data?.id,
    resolution: "refund",
    resolution_note: "Idempotent retry",
    stripe_refund_id: refundId,
  });
  const conflictingResolution = await admin.rpc("resolve_booking_dispute", {
    dispute_id: participantDispute.data?.id,
    resolution: "release",
    resolution_note: "Must fail",
  });
  check("same dispute resolution is idempotent", !repeatedResolution.error && repeatedResolution.data?.alreadyResolved === true);
  check("opposite dispute resolution fails closed", conflictingResolution.error !== null);

  const cancellationBookingId = `bk-cancel-${Date.now()}`;
  const cancellationGigAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const cancellationOffer = await A.client.from("bookings").insert({
    id: cancellationBookingId,
    user_id: A.id,
    musician_id: B.id,
    musician_user_id: B.id,
    gig_title: "Late cancellation test gig",
    date: "Today",
    time: "Soon",
    gig_at: cancellationGigAt,
    amount: 200,
    status: "offer",
  });
  const cancellationAccept = await B.client.from("bookings")
    .update({ status: "accepted" }).eq("id", cancellationBookingId);
  const cancellationHold = await admin.from("bookings")
    .update({ status: "held" }).eq("id", cancellationBookingId);
  const lateCancellationPayment = await admin.from("booking_payments").insert({
    booking_id: cancellationBookingId,
    payer_id: A.id,
    payee_id: B.id,
    stripe_payment_intent_id: `pi_RlsCancel${Date.now()}`,
    currency: "usd",
    musician_amount_cents: 20000,
    service_fee_cents: 2000,
    total_amount_cents: 22000,
    status: "held",
    authorization_expires_at: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString(),
  }).select("id").single();
  check("server can prepare a held booking for cancellation testing", !cancellationOffer.error && !cancellationAccept.error && !cancellationHold.error && !lateCancellationPayment.error);

  const forgedCancellationClaim = await A.client.rpc("claim_held_booking_cancellation", {
    booking_id: cancellationBookingId,
    cancelled_by: A.id,
  });
  check("participant cannot bypass the cancellation Edge Function", forgedCancellationClaim.error !== null);

  const cancellationClaim = await admin.rpc("claim_held_booking_cancellation", {
    booking_id: cancellationBookingId,
    cancelled_by: A.id,
  });
  check("late booker cancellation claims exactly 50% payout and fee", !cancellationClaim.error && cancellationClaim.data?.action === "late_fee" && cancellationClaim.data?.musicianPayoutCents === 10000 && cancellationClaim.data?.serviceFeeCents === 1000);

  const cancellationFinalize = await admin.rpc("finalize_held_booking_cancellation", {
    cancellation_id: cancellationClaim.data?.cancellationId,
  });
  const [cancelledBooking, partiallyRefundedPayment, cancellationNotice] = await Promise.all([
    admin.from("bookings").select("status").eq("id", cancellationBookingId).single(),
    admin.from("booking_payments").select("status").eq("booking_id", cancellationBookingId).single(),
    B.client.from("notifications").select("kind,body").eq("recipient_id", B.id).eq("kind", "booking_cancelled").like("body", "%late-cancellation payout%"),
  ]);
  check("late cancellation atomically closes booking and payment", !cancellationFinalize.error && cancelledBooking.data?.status === "cancelled" && partiallyRefundedPayment.data?.status === "partially_refunded");
  check("musician receives the private late-cancellation payout notice", cancellationNotice.data?.length === 1);

  const repeatedCancellation = await admin.rpc("finalize_held_booking_cancellation", {
    cancellation_id: cancellationClaim.data?.cancellationId,
  });
  check("booking cancellation finalization is idempotent", !repeatedCancellation.error && repeatedCancellation.data?.alreadyCompleted === true);

  const bNotifications = await B.client.from("notifications").select("id,kind").in("kind", ["direct_message", "booking_offer"]);
  const cNotifications = await C.client.from("notifications").select("id").eq("recipient_id", B.id);
  check("B receives durable message and offer notifications", new Set((bNotifications.data ?? []).map((row) => row.kind)).size === 2);
  check("C cannot read B's notifications", !cNotifications.error && (cNotifications.data?.length ?? 0) === 0);

  // ---- isolation: B must not SEE any of A's rows ----
  console.log("\nuser B reading user A's data (must be empty):");
  const reads = {
    follows: await B.client.from("follows").select("*").eq("user_id", A.id),
    bookings: await B.client.from("bookings").select("*").eq("id", bookingId),
    conversations: await B.client.from("conversations").select("*").eq("user_id", A.id),
    messages: await B.client.from("messages").select("*").eq("conversation_id", convId),
    liked_posts: await B.client.from("liked_posts").select("*").eq("user_id", A.id),
    responded_sub_posts: await B.client.from("responded_sub_posts").select("*").eq("user_id", A.id),
    openings: await B.client.from("openings").select("*").eq("user_id", A.id),
    user_projects: await B.client.from("user_projects").select("*").eq("user_id", A.id),
    group_conversations: await B.client.from("group_conversations").select("*").eq("user_id", A.id),
  };
  for (const [table, res] of Object.entries(reads)) {
    check(`B sees 0 of A's ${table}`, !res.error && (res.data?.length ?? 0) === 0);
  }
  const publicAProfile = await B.client.from("profiles").select("id,handle").eq("id", A.id);
  check("B CAN read A's completed public profile", (publicAProfile.data?.length ?? 0) === 1);

  // ---- isolation: B must not MUTATE A's rows ----
  console.log("\nuser B mutating user A's data (must not take effect):");
  // The legacy booking has no invited account; B is not a participant.
  await B.client.from("bookings").update({ status: "held" }).eq("id", bookingId);
  const afterUpd = await admin.from("bookings").select("status").eq("id", bookingId).single();
  check("B cannot change A's booking status", afterUpd.data?.status === "offer");

  await B.client.from("bookings").delete().eq("id", bookingId);
  const afterDel = await admin.from("bookings").select("id").eq("id", bookingId);
  check("B cannot delete A's booking", (afterDel.data?.length ?? 0) === 1);

  const forge = await B.client.from("follows").insert({ user_id: A.id, target_id: "v-armadillo" });
  check("B cannot forge a row owned by A (WITH CHECK)", forge.error !== null);

  const forgeOpening = await B.client.from("openings").insert({ id: `op-forge-${Date.now()}`, user_id: A.id, instrument: "bass", posted_by_kind: "player", posted_by_id: "me", when_label: "Tonight", fee: 999 });
  check("B cannot forge an opening owned by A (fee privacy)", forgeOpening.error !== null);

  const forgeProject = await B.client.from("user_projects").insert({ id: `proj-forge-${Date.now()}`, user_id: A.id, data: {} });
  check("B cannot forge a project owned by A", forgeProject.error !== null);

  // ---- positive control: B sees its own data ----
  console.log("\npositive control:");
  const ownProfile = await B.client.from("profiles").select("*").eq("id", B.id);
  check("B CAN read its own profile", !ownProfile.error && (ownProfile.data?.length ?? 0) === 1);

  // ---- cleanup ----
  if (paymentSeed.data?.id) {
    await admin.from("booking_payments").delete().eq("id", paymentSeed.data.id);
  }
  if (participantDispute.data?.id) {
    await admin.from("booking_disputes").delete().eq("id", participantDispute.data.id);
  }
  if (disputePayment.data?.id) {
    await admin.from("booking_payments").delete().eq("id", disputePayment.data.id);
  }
  if (cancellationClaim.data?.cancellationId) {
    await admin.from("booking_cancellations").delete().eq("id", cancellationClaim.data.cancellationId);
  }
  if (lateCancellationPayment.data?.id) {
    await admin.from("booking_payments").delete().eq("id", lateCancellationPayment.data.id);
  }
  await admin.storage.from("booking-check-ins").remove([recordingPath]);
  await admin.auth.admin.deleteUser(A.id);
  await admin.auth.admin.deleteUser(B.id);
  await admin.auth.admin.deleteUser(C.id);
  await admin.from("bookings").delete().eq("id", bookingId); // in case cascade lagged

  console.log(`\n\x1b[1m${passed} passed, ${failures.length} failed\x1b[0m`);
  if (failures.length) {
    console.log("\x1b[31mFAILURES:\x1b[0m\n  - " + failures.join("\n  - "));
    process.exit(1);
  }
  console.log("\x1b[32mAll RLS isolation checks passed.\x1b[0m");
}

main().catch((e) => {
  console.error("\x1b[31mRLS test run errored:\x1b[0m", e.message);
  process.exit(1);
});
