import { describe, expect, it, vi } from "vitest";

type QueryResult = { data: unknown; error: null };

const rows: Record<string, unknown> = {
  profiles: { id: "user-1", handle: "player", scene: "nashville" },
  follows: [],
  bookings: [],
  booking_check_ins: [],
  conversations: [],
  messages: [],
  direct_conversations: [],
  direct_messages: [],
  direct_conversation_reads: [],
  notifications: [],
  notification_preferences: null,
  liked_posts: [],
  responded_sub_posts: [],
  openings: [
    {
      id: "nashville-opening",
      scene: "nashville",
      instrument: "drums",
      posted_by_kind: "player",
      posted_by_id: "user-1",
      when_label: "Tonight",
      created_at: new Date().toISOString(),
    },
    {
      id: "legacy-opening",
      instrument: "bass",
      posted_by_kind: "player",
      posted_by_id: "user-1",
      when_label: "Tomorrow",
      created_at: new Date().toISOString(),
    },
  ],
  user_projects: [],
  group_conversations: [],
};
const deletedTables: string[] = [];

function query(data: unknown, table?: string) {
  const result: QueryResult = { data, error: null };
  const chain = {
    select: () => chain,
    delete: () => {
      if (table) deletedTables.push(table);
      return chain;
    },
    eq: () => chain,
    gt: () => chain,
    not: () => chain,
    or: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: () => Promise.resolve(result),
    then: <TResult1 = QueryResult, TResult2 = never>(
      onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) => Promise.resolve(result).then(onfulfilled, onrejected),
  };
  return chain;
}

vi.mock("../supabase", () => ({
  supabase: {
    from: (table: string) => query(rows[table], table),
    rpc: () => Promise.resolve({ data: [], error: null }),
    storage: {
      from: () => ({
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `https://example.test/${path}` },
        }),
        createSignedUrl: (path: string) => Promise.resolve({
          data: { signedUrl: `https://example.test/private/${path}` },
          error: null,
        }),
      }),
    },
  },
}));

import { supabaseBackend } from "./supabase";

describe("supabaseBackend.load", () => {
  it("preserves an opening's stored scene and defaults only legacy rows to Austin", async () => {
    const data = await supabaseBackend.load({ id: "user-1", email: null });

    expect(data.openings.map((opening) => [opening.id, opening.scene])).toEqual([
      ["nashville-opening", "nashville"],
      ["legacy-opening", "austin"],
    ]);
  });

  it("attaches private signed check-in recordings to their booking", async () => {
    const previousBookings = rows.bookings;
    const previousCheckIns = rows.booking_check_ins;
    rows.bookings = [{
      id: "bk-1",
      user_id: "user-1",
      musician_id: "player-2",
      gig_title: "Future show",
      venue_name: "Room",
      date: "Saturday",
      time: "9 PM",
      amount: 200,
      status: "accepted",
    }];
    rows.booking_check_ins = [{
      id: "ci-1",
      booking_id: "bk-1",
      due_at: "2026-08-08T00:00:00.000Z",
      request: "Play the bridge.",
      status: "submitted",
      recording_path: "bk-1/ci-1/player-2/take.mp4",
      recording_name: "take.mp4",
      submitted_at: "2026-08-07T00:00:00.000Z",
    }];

    try {
      const data = await supabaseBackend.load({ id: "user-1", email: null });
      expect(data.bookings[0]?.checkIns?.[0]).toMatchObject({
        id: "ci-1",
        request: "Play the bridge.",
        status: "submitted",
        recordingName: "take.mp4",
        recordingUrl: "https://example.test/private/bk-1/ci-1/player-2/take.mp4",
      });
    } finally {
      rows.bookings = previousBookings;
      rows.booking_check_ins = previousCheckIns;
    }
  });
});

describe("supabaseBackend.loadCatalog", () => {
  it("returns completed account profiles without requiring media or legacy seed rows", async () => {
    const previousProfiles = rows.profiles;
    rows.profiles = [
      {
        id: "9db031de-bb23-4da7-826c-f47aa12cc5e5",
        scene: "austin",
        name: "Fresh Account",
        handle: "fresh_account",
        instruments: ["drums"],
        genres: [],
        bio: "",
        gear: [],
        neighborhood: "East Austin",
        rate_min: null,
        rate_max: null,
        availability: [],
        reels: [],
        avatar_path: null,
      },
    ];

    try {
      const catalog = await supabaseBackend.loadCatalog("austin");

      expect(catalog).not.toBeNull();
      expect(catalog?.players).toHaveLength(1);
      expect(catalog?.players[0]).toMatchObject({
        id: "9db031de-bb23-4da7-826c-f47aa12cc5e5",
        handle: "fresh_account",
        videos: [],
        reels: [],
      });
      expect(catalog?.bands).toEqual([]);
      expect(catalog?.venues).toEqual([]);
      expect(catalog?.events).toEqual([]);
      expect(catalog?.feedPosts).toEqual([]);
    } finally {
      rows.profiles = previousProfiles;
    }
  });
});

describe("supabaseBackend.reset", () => {
  it("clears every user-owned prototype activity table while keeping the profile", async () => {
    deletedTables.length = 0;

    await supabaseBackend.reset({ id: "user-1", email: null });

    expect(deletedTables).toEqual([
      "follows",
      "bookings",
      "conversations",
      "liked_posts",
      "responded_sub_posts",
      "openings",
      "user_projects",
      "group_conversations",
    ]);
    expect(deletedTables).not.toContain("profiles");
  });
});
