-- The strategies shown on the Home and Developed tabs.
--
-- Run this ONCE in Supabase -> SQL Editor. It creates the table, opens it to
-- the site's public (anon) key the same way the `prices` table already is,
-- and seeds it with the strategies from strategies.json. Until it has been
-- run, the site falls back to reading strategies.json and the add/remove
-- buttons are disabled.
--
-- `def` is one strategies.json entry (minus id/active): the walk parameters
-- the engine reads. `on_home` replaces strategies.json's `active` flag.
-- Safe to re-run: the seed skips ids that already exist.

create table if not exists public.strategies (
  id          text primary key,
  position    integer not null default 0,
  on_home     boolean not null default false,
  def         jsonb   not null,
  created_at  timestamptz not null default now()
);

alter table public.strategies enable row level security;

-- Same trust model as `prices`: the anon key is public and can read and
-- write. Anyone who has the site's URL can therefore edit this list.
drop policy if exists "strategies anon read"   on public.strategies;
drop policy if exists "strategies anon insert" on public.strategies;
drop policy if exists "strategies anon update" on public.strategies;
drop policy if exists "strategies anon delete" on public.strategies;
create policy "strategies anon read"   on public.strategies for select to anon using (true);
create policy "strategies anon insert" on public.strategies for insert to anon with check (true);
create policy "strategies anon update" on public.strategies for update to anon using (true) with check (true);
create policy "strategies anon delete" on public.strategies for delete to anon using (true);

insert into public.strategies (id, position, on_home, def) values
  ('btc-sma120-voltarget', 0, true, '{"name": "Bitcoin", "liveAsset": "BTC", "backtestAsset": "BTC", "smaLen": 120, "buffer": 0, "volLen": 20, "volGate": null, "annualization": 365, "sizing": {"mode": "volTarget", "volTarget": 0.6, "maxSize": 1.0, "rebalanceBand": 0.15}, "leverage": {"base": 1, "gated": null}, "meterRange": {"min": -6, "max": 22}, "execution": "Signal from BTC 24/7 close; execute next LSE session. WXBT (WisdomTree Physical Bitcoin ETP, 0.15% TER) on Trading 212 Invest."}'::jsonb),
  ('spy-sma200-volgate', 1, true, '{"name": "S&P 500", "liveAsset": "SPY", "backtestAsset": "SPX_MERGED", "smaLen": 200, "buffer": 0.03, "volLen": 20, "volGate": 0.22, "annualization": 252, "leverage": {"base": 5, "gated": 3}, "meterRange": {"min": -6, "max": 14}}'::jsonb),
  ('btc-sma40', 2, false, '{"name": "Bitcoin (40d)", "archived": true, "liveAsset": "BTC", "backtestAsset": "BTC", "smaLen": 40, "buffer": 0, "volLen": null, "volGate": null, "annualization": 365, "leverage": {"base": 1, "gated": null}, "meterRange": {"min": -6, "max": 22}}'::jsonb)
on conflict (id) do nothing;
