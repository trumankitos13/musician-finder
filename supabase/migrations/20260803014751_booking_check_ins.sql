-- Optional pre-show playing checks attached to a booking offer. The invited
-- player records the requested sections; only the two booking participants can
-- see the request or its private recording.

create table public.booking_check_ins (
  id text primary key,
  booking_id text not null references public.bookings(id) on delete cascade,
  due_at timestamptz not null,
  request text not null,
  status text not null default 'requested'
    check (status in ('requested', 'submitted', 'approved', 'changes_requested')),
  recording_path text,
  recording_name text,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint booking_check_ins_request_length
    check (char_length(btrim(request)) between 1 and 1000),
  constraint booking_check_ins_recording_name_length
    check (recording_name is null or char_length(btrim(recording_name)) between 1 and 240),
  constraint booking_check_ins_review_note_length
    check (review_note is null or char_length(review_note) <= 1000),
  constraint booking_check_ins_recording_pair check (
    (recording_path is null and recording_name is null)
    or (recording_path is not null and recording_name is not null)
  ),
  constraint booking_check_ins_unique_deadline unique (booking_id, due_at)
);

create index booking_check_ins_booking_due_idx
  on public.booking_check_ins (booking_id, due_at);
create index booking_check_ins_pending_due_idx
  on public.booking_check_ins (due_at)
  where status in ('requested', 'changes_requested');

alter table public.booking_check_ins enable row level security;

create policy "booking participants can read check-ins"
  on public.booking_check_ins for select to authenticated
  using (
    exists (
      select 1
      from public.bookings booking
      where booking.id = booking_id
        and (select auth.uid()) in (booking.user_id, booking.musician_user_id)
    )
  );

create policy "bookers can add check-ins to open offers"
  on public.booking_check_ins for insert to authenticated
  with check (
    exists (
      select 1
      from public.bookings booking
      where booking.id = booking_id
        and booking.user_id = (select auth.uid())
        and booking.status::text = 'offer'
        and due_at > now()
        and booking.gig_at is not null
        and due_at < booking.gig_at
    )
  );

create policy "booking participants can update check-ins"
  on public.booking_check_ins for update to authenticated
  using (
    exists (
      select 1
      from public.bookings booking
      where booking.id = booking_id
        and (select auth.uid()) in (booking.user_id, booking.musician_user_id)
    )
  )
  with check (
    exists (
      select 1
      from public.bookings booking
      where booking.id = booking_id
        and (select auth.uid()) in (booking.user_id, booking.musician_user_id)
    )
  );

grant select, insert, update on public.booking_check_ins to authenticated;

-- Cross-row deadlines and role-specific state transitions cannot be expressed
-- with table CHECK constraints alone. Keep the proof path and timestamps under
-- the same database guard as the booking lifecycle.
create function public.enforce_booking_check_in_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  booking public.bookings%rowtype;
begin
  select * into booking
  from public.bookings
  where id = new.booking_id;

  if booking.id is null then
    raise exception 'booking not found';
  end if;

  if tg_op = 'INSERT' then
    if actor is distinct from booking.user_id or booking.status::text <> 'offer' then
      raise exception 'only the booker can add check-ins to an open offer';
    end if;
    if booking.musician_user_id is null then
      raise exception 'check-ins require an account-backed player';
    end if;
    if booking.gig_at is null or new.due_at <= now() or new.due_at >= booking.gig_at then
      raise exception 'check-in deadline must be in the future and before showtime';
    end if;
    new.request := btrim(new.request);
    new.status := 'requested';
    new.recording_path := null;
    new.recording_name := null;
    new.submitted_at := null;
    new.reviewed_at := null;
    new.review_note := null;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  if new.id is distinct from old.id
    or new.booking_id is distinct from old.booking_id
    or new.due_at is distinct from old.due_at
    or new.request is distinct from old.request
    or new.created_at is distinct from old.created_at then
    raise exception 'check-in request details cannot change after the offer is sent';
  end if;

  if actor = booking.musician_user_id
    and booking.status::text in ('accepted', 'held')
    and old.status in ('requested', 'changes_requested')
    and new.status = 'submitted' then
    if new.recording_path is null
      or new.recording_name is null
      or new.recording_path not like old.booking_id || '/' || old.id || '/' || actor::text || '/%' then
      raise exception 'player check-in recording path is invalid';
    end if;
    new.submitted_at := now();
    new.reviewed_at := null;
    new.review_note := null;
  elsif actor = booking.user_id
    and booking.status::text in ('accepted', 'held')
    and old.status = 'submitted'
    and new.status in ('approved', 'changes_requested') then
    if new.recording_path is distinct from old.recording_path
      or new.recording_name is distinct from old.recording_name
      or new.submitted_at is distinct from old.submitted_at then
      raise exception 'bookers cannot replace player recordings';
    end if;
    new.review_note := nullif(btrim(new.review_note), '');
    new.reviewed_at := now();
  else
    raise exception 'invalid check-in transition for this participant';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.enforce_booking_check_in_change() from public;

create trigger enforce_booking_check_in_change
  before insert or update on public.booking_check_ins
  for each row execute function public.enforce_booking_check_in_change();

-- One RPC keeps the booking and its requested checks in the same transaction.
create function public.create_booking_offer_with_check_ins(
  p_id text,
  p_musician_user_id uuid,
  p_gig_title text,
  p_venue_name text,
  p_date text,
  p_time text,
  p_gig_at timestamptz,
  p_amount integer,
  p_opening_id text,
  p_check_ins jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if jsonb_typeof(p_check_ins) <> 'array'
    or jsonb_array_length(p_check_ins) not between 1 and 6 then
    raise exception 'a booking may request between one and six check-ins';
  end if;

  insert into public.bookings (
    id, user_id, musician_id, musician_user_id, gig_title, venue_name,
    date, time, gig_at, amount, status, opening_id
  ) values (
    p_id, auth.uid(), p_musician_user_id::text, p_musician_user_id,
    p_gig_title, p_venue_name, p_date, p_time, p_gig_at, p_amount, 'offer', p_opening_id
  );

  insert into public.booking_check_ins (id, booking_id, due_at, request)
  select entry.id, p_id, entry.due_at, entry.request
  from jsonb_to_recordset(p_check_ins) as entry(id text, due_at timestamptz, request text);
end;
$$;

revoke execute on function public.create_booking_offer_with_check_ins(
  text, uuid, text, text, text, text, timestamptz, integer, text, jsonb
) from public, anon;
grant execute on function public.create_booking_offer_with_check_ins(
  text, uuid, text, text, text, text, timestamptz, integer, text, jsonb
) to authenticated;

-- Recordings are private and addressed by
-- <booking>/<check-in>/<player>/<unique file>.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'booking-check-ins',
  'booking-check-ins',
  false,
  52428800,
  array['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "players can upload requested check-ins"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'booking-check-ins'
    and (storage.foldername(name))[3] = (select auth.uid()::text)
    and exists (
      select 1
      from public.booking_check_ins check_in
      join public.bookings booking on booking.id = check_in.booking_id
      where check_in.id = (storage.foldername(name))[2]
        and check_in.booking_id = (storage.foldername(name))[1]
        and booking.musician_user_id = (select auth.uid())
        and booking.status::text in ('accepted', 'held')
        and check_in.status in ('requested', 'changes_requested')
    )
  );

create policy "booking participants can view check-in recordings"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'booking-check-ins'
    and exists (
      select 1
      from public.booking_check_ins check_in
      join public.bookings booking on booking.id = check_in.booking_id
      where check_in.id = (storage.foldername(name))[2]
        and check_in.booking_id = (storage.foldername(name))[1]
        and (select auth.uid()) in (booking.user_id, booking.musician_user_id)
    )
  );

create policy "players can remove unused check-in uploads"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'booking-check-ins'
    and (storage.foldername(name))[3] = (select auth.uid()::text)
    and exists (
      select 1
      from public.booking_check_ins check_in
      join public.bookings booking on booking.id = check_in.booking_id
      where check_in.id = (storage.foldername(name))[2]
        and check_in.booking_id = (storage.foldername(name))[1]
        and booking.musician_user_id = (select auth.uid())
        and check_in.recording_path is distinct from name
    )
  );

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'booking_check_ins'
  ) then
    execute 'alter publication supabase_realtime add table public.booking_check_ins';
  end if;
end
$$;
