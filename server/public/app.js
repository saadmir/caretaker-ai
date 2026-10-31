// Caretaker AI dashboard. The server pushes a full state snapshot over SSE on every
// change; render() redraws from it. Buttons POST to the JSON API.

const $ = (id) => document.getElementById(id);
let S = null;

const fmt = (iso, opts) => iso ? new Date(iso).toLocaleString([], { timeZone: S?.settings.timezone, ...(opts ?? { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }) : '—';
function ago(iso) {
  if (!iso) return '';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (h < 48) return h + ' h ago';
  return Math.floor(h / 24) + ' days ago';
}
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const SHORT = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };

function render() {
  if (!S) return;
  renderZones();
  renderAutoRule();
  renderHistory();
  renderWeather();
  renderController();
  renderAi();
  $('log').innerHTML = S.events.map((e) =>
    `<li><time>${fmt(e.at, SHORT)}</time><span class="t-${e.type}">${esc(e.message)}</span></li>`).join('');
}

// Zone cards are built once (so a chosen run time survives redraws), then updated in place.
const zoneEls = new Map();
function zoneCard(z) {
  let el = zoneEls.get(z.id);
  if (el) return el;
  el = $('zoneTpl').content.firstElementChild.cloneNode(true);
  const q = (c) => el.querySelector('.' + c);
  q('zmin').value = String(S.settings.defaultManualMinutes);
  if (!q('zmin').value) q('zmin').value = '30';
  q('ztoggle').onclick = () => {
    const zone = S.zones.find((x) => x.id === z.id);
    const on = zone?.valve.valve === 'on';
    post('/api/valve', on ? { action: 'off', zone: z.id } : { action: 'on', zone: z.id, minutes: Number(q('zmin').value) }, q('zerr'));
  };
  q('zauto').onchange = (e) => post('/api/auto', { zone: z.id, enabled: e.target.checked }, q('zerr'));
  $('zones').append(el);
  zoneEls.set(z.id, el);
  return el;
}

function renderZones() {
  for (const z of S.zones) {
    const el = zoneCard(z), q = (c) => el.querySelector('.' + c);
    const d = z.valve, on = d.valve === 'on';
    el.className = 'card hero ' + (on ? 'on' : 'off');
    q('zname').textContent = z.name;
    q('state').textContent = !d.online && d.valve === 'unknown' ? 'OFFLINE' : on ? 'ON' : 'OFF';

    let sub = '';
    if (!d.online) sub = 'Controller offline — commands unavailable';
    else if (on && d.onSince) {
      sub = `Running ${mmss((Date.now() - Date.parse(d.onSince)) / 1000)}`;
      if (d.remainingSec != null) {
        // remainingSec was true at the last heartbeat; count down from there.
        const left = Math.max(0, d.remainingSec - (Date.now() - Date.parse(d.lastSeenAt)) / 1000);
        sub += ` · ${mmss(left)} left`;
      }
      if (d.reason) sub += ` · ${d.reason}`;
      if (d.flowGpm != null) sub += ` · ${d.flowGpm.toFixed(1)} gal/min · ${(d.runGallons ?? 0).toFixed(1)} gal`;
    } else if (d.valve === 'off') {
      sub = z.lastWateredAt ? 'Last ran ' + ago(z.lastWateredAt) : 'Never run';
    }
    q('zsub').textContent = sub;

    const btn = q('ztoggle');
    btn.disabled = !d.online;
    btn.textContent = on ? 'Turn off' : 'Turn on';
    btn.classList.toggle('stop', on);
    q('zmin').disabled = on || !d.online;
    q('zauto').checked = z.autoEnabled;

    const rule = z.decision;
    let note = '', warn = false;
    if (!S.autoEnabled) note = '';
    else if (!z.autoEnabled) { note = 'Automatic watering is off for this zone. Manual runs only.'; warn = true; }
    else if (S.ai.mode === 'auto' && S.ai.apiKeySet) note = '';
    else if (rule && !rule.isDue) note = `Dry for ${rule.hoursDry} h. Next automatic run due ${fmt(rule.dueAt)}.`;
    else if (rule && rule.blockedBy) { note = `Due now, on hold: ${rule.blockedBy}.`; warn = true; }
    else if (rule) note = 'Due now — starting.';
    q('zrule').textContent = note;
    q('zrule').hidden = !note;
    q('zrule').className = 'note zrule' + (warn ? ' warn' : '');
  }
  const d = S.device;
  $('conn').textContent = d.online ? 'online' : 'offline';
  $('conn').className = 'pill ' + (d.online ? 'ok' : 'bad');
}

function renderAutoRule() {
  const st = S.settings;
  $('auto').checked = S.autoEnabled;
  $('autoDesc').textContent = S.ai.mode === 'auto' && S.ai.apiKeySet
    ? 'The AI gardener plans each morning. The plain rule below only applies on days the AI is unavailable.'
    : `${st.autoRunMinutes} min after ${st.dryHoursThreshold} h without rain or watering, ${st.windowStartHour}:00–${st.windowEndHour}:00, skipped if rain now or within 24 h. Each zone also has its own Auto switch.`;
  $('decision').textContent = S.autoEnabled ? 'On. Each zone shows when it is next due.' : 'Paused. No automatic watering in any zone until you turn this back on.';
  $('decision').className = 'note' + (S.autoEnabled ? '' : ' warn');
}

const zoneName = (id) => S.zones.find((z) => z.id === id)?.name ?? `Zone ${id}`;
const gpmText = (z) => z.gallonsPerMinute == null ? 'unknown (no emitter count yet)' : `${z.gallonsPerMinute} gal/min (${z.flowMeasured ? 'measured' : 'estimated'})`;

function renderHistory() {
  const when = (iso, none) => iso ? `${fmt(iso)} (${ago(iso)})` : none;
  const rows = [['Last rain', when(S.history.lastRainAt, 'none recorded')]];
  for (const z of S.zones) {
    rows.push([`${z.name} last watered`, when(z.lastWateredAt, 'never')]);
    rows.push([`${z.name} flow`, gpmText(z)]);
  }
  $('hist').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  $('waterings').innerHTML = S.waterings.length ? S.waterings.map((w) => {
    const gpm = S.zones.find((z) => z.id === w.zone)?.gallonsPerMinute;
    const gal = w.gallons != null ? `<b>${w.gallons} gal</b>` : gpm != null ? `≈${Math.round(w.minutes * gpm)} gal` : '? gal';
    return `<li><time>${fmt(w.start, SHORT)}</time><span>${esc(zoneName(w.zone))} · ${w.minutes} min · ${gal} · ${esc(w.reason)}</span></li>`;
  }).join('') : '<li><span class="sub">None yet</span></li>';
}

function renderWeather() {
  const w = S.weather;
  if (w) {
    const temp = w.temperatureC != null ? Math.round(w.temperatureC) + '°C · ' : '';
    $('wNow').textContent = `${temp}${w.rainingNow ? 'raining' : 'dry'}${w.currentPrecipitationMm ? ` (${w.currentPrecipitationMm} mm)` : ''}`;
    $('wNext').textContent = `${w.next24hTotalMm} mm · max ${w.next24hMaxProbability}%`;
    const f = w.rainForecast;
    $('wFc').textContent = f ? `${fmt(f.at)} (${f.precipitationMm} mm, ${f.probability ?? '?'}%)` : 'none';
    $('wAge').textContent = 'updated ' + ago(w.fetchedAt);
  }
  $('wErr').hidden = !S.weatherError;
  $('wErr').textContent = S.weatherError ? 'Weather error: ' + S.weatherError : '';
}

function renderController() {
  const d = S.device;
  $('dOnline').textContent = d.online ? `online${d.ip ? ' · ' + d.ip : ''}` : 'offline';
  $('dRssi').textContent = d.rssi != null ? `${d.rssi} dBm` : '—';
  $('dSeen').textContent = d.lastSeenAt ? ago(d.lastSeenAt) : '—';
  $('dFail').textContent = d.failsafeMin ? `${d.failsafeMin} min` : '—';
  const metered = S.zones.filter((z) => z.valve.flowGpm != null);
  $('dFlow').textContent = metered.length ? metered.map((z) => `${z.name}: ${z.valve.flowGpm.toFixed(2)} gal/min now`).join(' · ') : 'not reporting';
}

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const clock = (iso) => fmt(iso, { hour: 'numeric', minute: '2-digit' });
const MODE_DESC = {
  off: 'AI is off. The plain rules decide.',
  advise: 'The AI decides each morning and notifies you, but does not water. Use it to judge its advice.',
  auto: 'The AI decides and waters. The plain rules only cover days the AI is unavailable.',
};

function planText(p) {
  if (!p.cycles.length) return '';
  const gpm = S.zones.find((z) => z.id === p.zone)?.gallonsPerMinute;
  const total = p.cycles.reduce((a, c) => a + c.minutes, 0);
  const icon = { pending: '○', started: '●', skipped: '✕' };
  return '<div class="ai-plan">' + p.cycles.map((c) => `${icon[c.status]} ${clock(c.startAt)} — ${c.minutes} min`).join('<br>') +
    `<br><span class="ai-meta">${total} min total${gpm != null ? ` ≈ ${Math.round(total * gpm)} gal` : ''}</span></div>`;
}

function zonePlanHtml(p) {
  return `<div class="ai-zone"><b>${esc(zoneName(p.zone))}</b>: ${p.action === 'water' ? '💧 water' : '⏸ skip'} · soil ${esc(p.soilEstimate)}` +
    (p.note ? `<div class="ai-meta">${esc(p.note)}</div>` : '') + planText(p) +
    (p.adjustments.length ? `<div class="note warn">Limits applied: ${esc(p.adjustments.join(' '))}</div>` : '') + '</div>';
}

function renderAi() {
  const ai = S.ai;
  for (const b of $('aiMode').querySelectorAll('button')) b.classList.toggle('sel', b.dataset.mode === ai.mode);
  $('aiModeDesc').textContent = ai.apiKeySet ? MODE_DESC[ai.mode] : 'Add ANTHROPIC_API_KEY to the server .env to enable the AI.';
  $('aiStatus').textContent = ai.busy ? 'thinking…' : ai.error ? 'error' : ai.apiKeySet ? ai.model : 'no API key';
  $('aiStatus').className = 'pill' + (ai.error ? ' bad' : ai.apiKeySet && !ai.busy ? ' ok' : '');
  $('aiAsk').disabled = ai.busy || !ai.apiKeySet;
  $('aiAsk').textContent = ai.busy ? 'Thinking…' : 'Ask AI now';
  if (ai.error && !$('aiErr').textContent) $('aiErr').textContent = ai.error;

  const [d, ...past] = ai.decisions;
  $('aiLatest').innerHTML = d ? `
    <div class="ai-head">${d.action === 'water' ? '💧' : '⏸'} ${esc(d.headline)}</div>
    <div class="ai-meta">For ${fmt(d.forDate + 'T12:00:00', { weekday: 'short', month: 'short', day: 'numeric' })} · decided ${fmt(d.decidedAt)}${d.mode !== 'auto' ? ' · ' + d.mode + ' mode' : ''}</div>
    <div class="ai-why">${esc(d.reasoning)}</div>
    ${d.zones.map(zonePlanHtml).join('')}`
    : `<div class="note">No decision yet. The AI decides daily at ${ai.decisionTime} AM${ai.apiKeySet ? ', or tap “Ask AI now”.' : '.'}</div>`;
  $('aiPast').hidden = !past.length;
  $('aiPastList').innerHTML = past.map((p) =>
    `<li><b>${fmt(p.forDate + 'T12:00:00', { weekday: 'short', month: 'short', day: 'numeric' })}</b> ${p.action === 'water' ? '💧' : '⏸'} ${esc(p.headline)}</li>`).join('');

  $('notes').innerHTML = ai.notes.map((n) =>
    `<li><time>${fmt(n.at, { month: 'short', day: 'numeric' })}</time><span>${esc(n.text)}</span><button data-at="${n.at}" title="Delete">×</button></li>`).join('');
}

async function post(url, body, errEl) {
  errEl = typeof errEl === 'string' ? $(errEl) : errEl;
  errEl.textContent = '';
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return true;
  } catch (e) { errEl.textContent = e.message; return false; }
}

$('aiMode').onclick = (e) => {
  const mode = e.target.dataset?.mode;
  if (!mode || mode === S?.ai.mode) return;
  if (mode === 'auto' && !confirm('Let the AI water automatically (within the safety limits)?')) return;
  post('/api/ai/mode', { mode }, 'aiErr');
};
$('aiAsk').onclick = () => post('/api/ai/decide', {}, 'aiErr');
$('noteAdd').onclick = async () => {
  const text = $('noteText').value.trim();
  if (text && await post('/api/notes', { text }, 'aiErr')) $('noteText').value = '';
};
$('notes').onclick = (e) => {
  const at = e.target.dataset?.at;
  if (at && confirm('Delete this note?')) post('/api/notes/delete', { at }, 'aiErr');
};

$('auto').onchange = (e) => post('/api/auto', { enabled: e.target.checked }, 'autoErr');

function connect() {
  const es = new EventSource('/api/stream');
  es.onmessage = (ev) => { S = JSON.parse(ev.data); render(); };
  es.onerror = () => { $('conn').textContent = 'reconnecting…'; $('conn').className = 'pill bad'; };
}
connect();
setInterval(render, 1000);
