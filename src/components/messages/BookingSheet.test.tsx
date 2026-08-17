import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PLAYERS } from "../../lib/data";
import { scheduleOpening, tomorrowIso } from "../../lib/scheduling";
import { BookingSheet } from "./BookingSheet";

const sendBookingOffer = vi.fn();

vi.mock("../../lib/store", () => ({
  useApp: () => ({
    state: { openings: [], projects: [] },
    api: { sendBookingOffer },
  }),
}));

describe("BookingSheet", () => {
  afterEach(() => {
    cleanup();
    sendBookingOffer.mockClear();
  });

  it("uses Tomorrow without submitting and persists the canonical gig instant", async () => {
    const user = userEvent.setup();
    const musician = PLAYERS[0]!;
    const onClose = vi.fn();
    render(
      <BookingSheet open onClose={onClose} musician={musician} />,
    );

    await user.click(screen.getByRole("button", { name: "Tomorrow" }));
    expect(sendBookingOffer).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Gig date")).toHaveValue(tomorrowIso());

    await user.click(screen.getByRole("button", { name: "Send offer" }));

    const scheduled = scheduleOpening(tomorrowIso(), "21:00");
    const [date, time] = scheduled.label.split(" · ");
    expect(sendBookingOffer).toHaveBeenCalledWith(expect.objectContaining({
      playerId: musician.id,
      date,
      time,
      gigAt: scheduled.gigAt,
    }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("adds optional five-day and two-day recording checks to a future offer", async () => {
    const user = userEvent.setup();
    const musician = PLAYERS[0]!;
    const showDate = new Date();
    showDate.setDate(showDate.getDate() + 7);
    const showDateInput = [
      showDate.getFullYear(),
      String(showDate.getMonth() + 1).padStart(2, "0"),
      String(showDate.getDate()).padStart(2, "0"),
    ].join("-");

    render(<BookingSheet open onClose={vi.fn()} musician={musician} />);
    fireEvent.change(screen.getByLabelText("Gig date"), { target: { value: showDateInput } });
    await user.click(screen.getByRole("checkbox", { name: /Require progress check-ins/i }));

    expect(screen.getByLabelText("Check-in 1 request")).toHaveValue(
      "Record the sections of the set that need the most preparation.",
    );
    expect(screen.getByLabelText("Check-in 2 request")).toHaveValue(
      "Play the requested sections cleanly in one continuous take.",
    );

    await user.click(screen.getByRole("button", { name: "Send offer" }));
    const booking = sendBookingOffer.mock.calls[0]?.[0];
    expect(booking.checkIns).toHaveLength(2);
    const gigAt = new Date(booking.gigAt).getTime();
    expect(gigAt - new Date(booking.checkIns[0].dueAt).getTime()).toBe(5 * 24 * 60 * 60 * 1000);
    expect(gigAt - new Date(booking.checkIns[1].dueAt).getTime()).toBe(2 * 24 * 60 * 60 * 1000);
  });
});
