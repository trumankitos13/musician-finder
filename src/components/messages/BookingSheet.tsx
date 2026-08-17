// Booking offer sheet — where the money flow starts. Cloud offers wait for the
// invited account; local demo mode keeps the simulated acceptance.

import { useState, type FormEvent } from "react";
import type { InstrumentId, Player } from "../../lib/types";
import { VENUES } from "../../lib/data";
import { useApp } from "../../lib/store";
import { isSelectableGigDate, scheduleOpening, todayIso, tomorrowIso } from "../../lib/scheduling";
import { Button, Chip, Modal } from "../ui";
import { CalendarIcon, CloseIcon, DollarIcon, LockIcon, PlusIcon } from "../icons";
import { Field, inputCls } from "./form";

/** how you'd refer to this player in a "our X can't make it" text */
const ROLE_NOUN: Record<InstrumentId, string> = {
  guitar: "guitarist",
  bass: "bassist",
  drums: "drummer",
  keys: "keys player",
  vocals: "singer",
  sax: "sax player",
  trumpet: "trumpet player",
  violin: "fiddle player",
  "pedal-steel": "steel player",
  dj: "DJ",
  "sound-tech": "sound engineer",
  "lighting-tech": "lighting tech",
};

function scheduleInputs(gigAt?: string): { date: string; time: string } {
  if (!gigAt || Number.isNaN(new Date(gigAt).getTime())) {
    return { date: todayIso(), time: "21:00" };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(gigAt));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    time: `${value("hour")}:${value("minute")}`,
  };
}

interface CheckInDraft {
  id: string;
  date: string;
  time: string;
  request: string;
}

function defaultCheckIns(gigAt: string): CheckInDraft[] {
  const show = new Date(gigAt).getTime();
  return [
    {
      id: crypto.randomUUID(),
      ...scheduleInputs(new Date(show - 5 * 24 * 60 * 60 * 1000).toISOString()),
      request: "Record the sections of the set that need the most preparation.",
    },
    {
      id: crypto.randomUUID(),
      ...scheduleInputs(new Date(show - 2 * 24 * 60 * 60 * 1000).toISOString()),
      request: "Play the requested sections cleanly in one continuous take.",
    },
  ];
}

export function BookingSheet({
  open,
  onClose,
  musician,
  openingId,
}: {
  open: boolean;
  onClose: () => void;
  musician: Player;
  /** offer fills this posted Opening — prefilled from it; holding locks the seat */
  openingId?: string;
}) {
  const { state, api } = useApp();
  const first = musician.name.split(" ")[0] ?? musician.name;
  const primary: InstrumentId = musician.instruments[0]?.id ?? "guitar";

  // when the offer is for a posted opening, prefill from it (fee = the posted
  // take-home; title = the project's name when one owns the opening)
  const opening = openingId ? state.openings.find((o) => o.id === openingId) : undefined;
  const project = opening
    ? state.projects.find((p) => p.id === opening.postedBy.id)
    : undefined;

  const [gigTitle, setGigTitle] = useState(project?.name ?? "Fill-in gig");
  const [venue, setVenue] = useState<string>(VENUES[0]?.name ?? "Other");
  const [customVenue, setCustomVenue] = useState("");
  const initialSchedule = scheduleInputs(opening?.gigAt);
  const [date, setDate] = useState(initialSchedule.date);
  const [time, setTime] = useState(initialSchedule.time);
  const [amount, setAmount] = useState(String(opening?.fee ?? musician.rate.min));
  const [note, setNote] = useState(
    project
      ? `Hey! Putting together ${project.name} — want the ${ROLE_NOUN[opening?.instrument ?? primary]} seat?`
      : `Hey! Our ${ROLE_NOUN[primary]} can't make it — can you cover?`,
  );
  const [checkInsEnabled, setCheckInsEnabled] = useState(false);
  const [checkIns, setCheckIns] = useState<CheckInDraft[]>([]);

  let scheduled: ReturnType<typeof scheduleOpening> | null = null;
  try {
    scheduled = scheduleOpening(date, time);
  } catch {
    scheduled = null;
  }
  const parsedAmount = Number(amount);
  const parsedCheckIns = checkIns.map((checkIn) => {
    try {
      return {
        dueAt: scheduleOpening(checkIn.date, checkIn.time).gigAt,
        request: checkIn.request.trim(),
      };
    } catch {
      return null;
    }
  });
  const showTime = scheduled ? new Date(scheduled.gigAt).getTime() : Number.NaN;
  const validCheckIns = !checkInsEnabled || (
    checkIns.length > 0
    && checkIns.length <= 6
    && parsedCheckIns.every((checkIn) => checkIn !== null
      && checkIn.request.length > 0
      && checkIn.request.length <= 1000
      && new Date(checkIn.dueAt).getTime() > Date.now()
      && new Date(checkIn.dueAt).getTime() < showTime)
    && new Set(parsedCheckIns.map((checkIn) => checkIn?.dueAt)).size === checkIns.length
  );
  const valid =
    gigTitle.trim().length > 0 &&
    scheduled !== null &&
    isSelectableGigDate(date, todayIso()) &&
    Number.isFinite(parsedAmount) &&
    parsedAmount > 0 &&
    parsedAmount <= 100000 &&
    validCheckIns;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid || !scheduled) return;
    const [dateLabel = date, timeLabel = time] = scheduled.label.split(" · ");
    api.sendBookingOffer({
      playerId: musician.id,
      gigTitle: gigTitle.trim(),
      venueName: venue === "Other" ? customVenue.trim() || "Venue TBD" : venue,
      date: dateLabel,
      time: timeLabel,
      gigAt: scheduled.gigAt,
      amount: Math.round(parsedAmount),
      note: note.trim() || undefined,
      openingId,
      checkIns: checkInsEnabled
        ? parsedCheckIns.flatMap((checkIn) => checkIn ? [checkIn] : [])
        : undefined,
    });
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={`Book ${first}`}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Event title">
          <input
            className={inputCls}
            value={gigTitle}
            onChange={(e) => setGigTitle(e.target.value)}
            maxLength={160}
            placeholder="Fill-in gig"
          />
        </Field>

        <Field label="Venue">
          <select
            className={inputCls}
            value={venue}
            onChange={(e) => setVenue(e.target.value)}
          >
            {VENUES.map((v) => (
              <option key={v.id} value={v.name}>
                {v.name}
              </option>
            ))}
            <option value="Other">Other</option>
          </select>
          {venue === "Other" && (
            <input
              className={`${inputCls} mt-2`}
              value={customVenue}
              onChange={(e) => setCustomVenue(e.target.value)}
              maxLength={160}
              placeholder="Where's the gig?"
            />
          )}
        </Field>

        <Field label="When's the gig?">
          <div className="mb-2 flex flex-wrap gap-2">
            <Chip active={date === todayIso()} onClick={() => setDate(todayIso())}>Today</Chip>
            <Chip active={date === tomorrowIso()} onClick={() => setDate(tomorrowIso())}>Tomorrow</Chip>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input
              aria-label="Gig date"
              type="date"
              min={todayIso()}
              className={inputCls}
              value={date}
              onChange={(event) => setDate(event.currentTarget.value)}
            />
            <input
              aria-label="Gig time"
              type="time"
              className={inputCls}
              value={time}
              onChange={(event) => setTime(event.currentTarget.value)}
            />
          </div>
        </Field>

        <Field
          label="Offer amount"
          hint={`Their rate: $${musician.rate.min}–$${musician.rate.max}`}
        >
          <div className="relative">
            <span className="mono absolute top-1/2 left-3.5 -translate-y-1/2 text-sm text-text-lo">
              $
            </span>
            <input
              type="number"
              min={1}
              max={100000}
              step="any"
              inputMode="numeric"
              className={`${inputCls} pl-7`}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
        </Field>

        <Field label="Note" hint="Optional">
          <textarea
            rows={2}
            className={`${inputCls} resize-none`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={4000}
          />
        </Field>

        <section className="rounded-2xl border border-hairline-subtle bg-surface-800/55 p-3.5">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              className="mt-1 size-4 accent-amber-400"
              checked={checkInsEnabled}
              onChange={(event) => {
                const enabled = event.currentTarget.checked;
                setCheckInsEnabled(enabled);
                if (enabled && checkIns.length === 0 && scheduled) {
                  setCheckIns(defaultCheckIns(scheduled.gigAt));
                }
              }}
            />
            <span>
              <span className="flex items-center gap-1.5 text-sm font-semibold text-text-hi">
                <CalendarIcon size={14} className="text-amber-300" /> Require progress check-ins
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-text-lo">
                Set deadlines and the sections {first} should record before the show.
              </span>
            </span>
          </label>

          {checkInsEnabled && (
            <div className="mt-3 space-y-3 border-t border-hairline-subtle pt-3">
              {checkIns.map((checkIn, index) => (
                <div key={checkIn.id} className="rounded-xl border border-amber-500/15 bg-ink-near p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="mono text-[10px] font-bold text-amber-300">
                      Check-in {index + 1}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove check-in ${index + 1}`}
                      className="rounded-lg p-1 text-text-lo hover:bg-surface-700 hover:text-text-hi"
                      onClick={() => setCheckIns((current) => current.filter((item) => item.id !== checkIn.id))}
                    >
                      <CloseIcon size={14} />
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      aria-label={`Check-in ${index + 1} date`}
                      type="date"
                      min={todayIso()}
                      max={date}
                      className={inputCls}
                      value={checkIn.date}
                      onChange={(event) => setCheckIns((current) => current.map((item) =>
                        item.id === checkIn.id ? { ...item, date: event.currentTarget.value } : item,
                      ))}
                    />
                    <input
                      aria-label={`Check-in ${index + 1} time`}
                      type="time"
                      className={inputCls}
                      value={checkIn.time}
                      onChange={(event) => setCheckIns((current) => current.map((item) =>
                        item.id === checkIn.id ? { ...item, time: event.currentTarget.value } : item,
                      ))}
                    />
                  </div>
                  <textarea
                    aria-label={`Check-in ${index + 1} request`}
                    rows={2}
                    className={`${inputCls} mt-2 resize-y`}
                    maxLength={1000}
                    value={checkIn.request}
                    placeholder="Which songs or sections should they play?"
                    onChange={(event) => setCheckIns((current) => current.map((item) =>
                      item.id === checkIn.id ? { ...item, request: event.currentTarget.value } : item,
                    ))}
                  />
                </div>
              ))}
              {checkIns.length < 6 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  onClick={() => {
                    if (!scheduled) return;
                    const fallback = scheduleInputs(new Date(
                      Math.max(Date.now() + 60 * 60 * 1000, new Date(scheduled.gigAt).getTime() - 24 * 60 * 60 * 1000),
                    ).toISOString());
                    setCheckIns((current) => [...current, {
                      id: crypto.randomUUID(),
                      ...fallback,
                      request: "",
                    }]);
                  }}
                >
                  <PlusIcon size={14} /> Add check-in
                </Button>
              )}
              {!validCheckIns && (
                <p className="text-[11px] leading-relaxed text-amber-300" role="alert">
                  Every check-in needs a unique future deadline before showtime and a recording request.
                </p>
              )}
            </div>
          )}
        </section>

        <Button type="submit" size="lg" disabled={!valid} className="w-full">
          <DollarIcon size={17} /> Send offer
        </Button>
        <p className="flex items-center justify-center gap-1.5 text-center text-[11px] text-text-lo">
          <LockIcon size={12} className="shrink-0" /> No charge yet — you only pay
          after {first} accepts.
        </p>
      </form>
    </Modal>
  );
}
