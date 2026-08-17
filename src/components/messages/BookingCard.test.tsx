import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PLAYERS } from "../../lib/data";
import type { Booking } from "../../lib/types";
import { BookingCard } from "./BookingCard";

const submitBookingCheckIn = vi.fn().mockResolvedValue(undefined);
const reviewBookingCheckIn = vi.fn().mockResolvedValue(undefined);

vi.mock("../../lib/store", () => ({
  useApp: () => ({
    state: { ratingsGiven: {} },
    api: {
      submitBookingCheckIn,
      reviewBookingCheckIn,
      respondToBooking: vi.fn(),
      cancelBooking: vi.fn(),
    },
  }),
}));

const baseBooking: Booking = {
  id: "bk-check-in-test",
  playerId: PLAYERS[0]!.id,
  gigTitle: "Saturday set",
  venueName: "The Ballroom",
  date: "Sat Aug 8",
  time: "9:00 PM",
  gigAt: "2026-08-09T02:00:00.000Z",
  amount: 250,
  status: "accepted",
  checkIns: [{
    id: "ci-test",
    dueAt: "2026-08-07T23:00:00.000Z",
    request: "Play the bridge and final chorus of Midnight Drive.",
    status: "requested",
  }],
};

describe("BookingCard check-ins", () => {
  afterEach(() => {
    cleanup();
    submitBookingCheckIn.mockClear();
    reviewBookingCheckIn.mockClear();
  });

  it("lets an incoming player choose a private check-in recording", async () => {
    const user = userEvent.setup();
    render(
      <BookingCard
        booking={{ ...baseBooking, direction: "incoming" }}
        musician={PLAYERS[0]!}
        onPay={vi.fn()}
      />,
    );

    expect(screen.getByText("Play the bridge and final chorus of Midnight Drive.")).toBeVisible();
    const recording = new File(["video"], "bridge.mp4", { type: "video/mp4" });
    await user.upload(screen.getByLabelText("Record or choose video"), recording);

    expect(submitBookingCheckIn).toHaveBeenCalledWith(
      baseBooking.id,
      "ci-test",
      recording,
    );
  });

  it("lets the outgoing booker approve a submitted take", async () => {
    const user = userEvent.setup();
    render(
      <BookingCard
        booking={{
          ...baseBooking,
          direction: "outgoing",
          checkIns: [{
            ...baseBooking.checkIns![0]!,
            status: "submitted",
            recordingUrl: "https://example.test/signed-recording.mp4",
          }],
        }}
        musician={PLAYERS[0]!}
        onPay={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(reviewBookingCheckIn).toHaveBeenCalledWith(
      baseBooking.id,
      "ci-test",
      "approved",
      "",
    );
  });
});
