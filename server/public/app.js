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
  renderValve();
  renderAutoRule();
  renderHistory();
  renderWeather();
  renderController();
  renderAi();
  $('log').innerHTML = S.events.map((e) =>
    `<li><time>${fmt(e.at, SHORT)}</time><span class="t-${e.type}">${esc(e.message)}</span></li>`).join('');
}

function renderValve() {
  const d = S.device, on = d.valve === 'on';
  $('hero').className = 'card hero ' + (on ? 'on' : 'off');
  $('state').textContent = !d.online && d.valve === 'unknown' ? 'OFFLINE' : on ? 'ON' : 'OFF';

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
  } else if (d.valve === 'off' && S.history.lastOffAt) {
    sub = 'Last ran ' + ago(S.history.lastWateredAt);
  }
  $('sub').textContent = sub;

  const btn = $('toggle');
  btn.disabled = !d.online;
  btn.textContent = on ? 'Turn off' : 'Turn on';
  btn.classList.toggle('stop', on);
  $('minutes').disabled = on || !d.online;
  $('conn').textContent = d.online ? 'online' : 'offline';
  $('conn').className = 'pill ' + (d.online ? 'ok' : 'bad');
}

function renderAutoRule() {
  const st = S.settings, rule = S.decision;
  $('auto').checked = S.autoEnabled;
  $('autoDesc').textContent = S.ai.mode === 'auto' && S.ai.apiKeySet
    ? 'The AI gardener plans each morning. The plain rule below only applies on days the AI is unavailable.'
    : `${st.autoRunMinutes} min after ${st.dryHoursThreshold} h without rain or watering, ${st.windowStartHour}:00–${st.windowEndHour}:00, skipped if rain now or within 24 h.`;

  let note = '', warn = false;
  if (!S.autoEnabled) { note = 'Paused. No automatic watering until you turn this back on.'; warn = true; }
  else if (rule && !rule.isDue) note = `Dry for ${rule.hoursDry} h. Next run due ${fmt(rule.dueAt)}.`;
  else if (rule && rule.blockedBy) { note = `Due now, on hold: ${rule.blockedBy}.`; warn = true; }
  else if (rule) note = 'Due now — starting.';
  $('decision').textContent = note;
  $('decision').className = 'note' + (warn ? ' warn' : '');
}

function renderHistory() {
  const h = S.history, st = S.settings;
  const when = (iso, none) => iso ? `${fmt(iso)} (${ago(iso)})` : none;
  $('lastRain').textContent = when(h.lastRainAt, 'none recorded');
  $('lastWatered').textContent = when(h.lastWateredAt, 'never');
  $('dueAt').textContent = S.decision ? fmt(S.decision.dueAt) : '—';
  $('gpm').textContent = `${st.gallonsPerMinute} gal/min (${st.flowMeasured ? 'measured' : 'estimated'})`;
  $('waterings').innerHTML = S.waterings.length ? S.waterings.map((w) => {
    const gal = w.gallons != null ? `<b>${w.gallons} gal</b>` : `≈${Math.round(w.minutes * st.gallonsPerMinute)} gal`;
    return `<li><time>${fmt(w.start, SHORT)}</time><span>${w.minutes} min · ${gal} · ${esc(w.reason)}</span></li>`;
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
  $('dFlow').textContent = d.flowGpm == null ? 'not reporting' : `${d.flowGpm.toFixed(2)} gal/min now`;
}

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const clock = (iso) => fmt(iso, { hour: 'numeric', minute: '2-digit' });
const MODE_DESC = {
  off: 'AI is off. The plain rules decide.',
  advise: 'The AI decides each morning and notifies you, but does not water. Use it to judge its advice.',
  auto: 'The AI decides and waters. The plain rules only cover days the AI is unavailable.',
};

function planText(d) {
  if (!d.cycles.length) return 'No watering.';
  const gpm = S.settings.gallonsPerMinute;
  const total = d.cycles.reduce((a, c) => a + c.minutes, 0);
  const icon = { pending: '○', started: '●', skipped: '✕' };
  return d.cycles.map((c) => `${icon[c.status]} ${clock(c.startAt)} — ${c.minutes} min`).join('<br>') +
    `<br><span class="ai-meta">${total} min total ≈ ${Math.round(total * gpm)} gal</span>`;
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
    <div class="ai-meta">For ${fmt(d.forDate + 'T12:00:00', { weekday: 'short', month: 'short', day: 'numeric' })} · decided ${fmt(d.decidedAt)} · soil ${esc(d.soilEstimate)}${d.mode !== 'auto' ? ' · ' + d.mode + ' mode' : ''}</div>
    <div class="ai-why">${esc(d.reasoning)}</div>
    <div class="ai-plan">${planText(d)}</div>
    ${d.adjustments.length ? `<div class="note warn">Limits applied: ${esc(d.adjustments.join(' '))}</div>` : ''}`
    : `<div class="note">No decision yet. The AI decides daily at ${ai.decisionTime} AM${ai.apiKeySet ? ', or tap “Ask AI now”.' : '.'}</div>`;
  $('aiPast').hidden = !past.length;
  $('aiPastList').innerHTML = past.map((p) =>
    `<li><b>${fmt(p.forDate + 'T12:00:00', { weekday: 'short', month: 'short', day: 'numeric' })}</b> ${p.action === 'water' ? '💧' : '⏸'} ${esc(p.headline)}</li>`).join('');

  $('notes').innerHTML = ai.notes.map((n) =>
    `<li><time>${fmt(n.at, { month: 'short', day: 'numeric' })}</time><span>${esc(n.text)}</span><button data-at="${n.at}" title="Delete">×</button></li>`).join('');
}

async function post(url, body, errEl = 'err') {
  $(errEl).textContent = '';
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return true;
  } catch (e) { $(errEl).textContent = e.message; return false; }
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

$('toggle').onclick = () => {
  const on = S?.device.valve === 'on';
  post('/api/valve', on ? { action: 'off' } : { action: 'on', minutes: Number($('minutes').value) });
};
$('auto').onchange = (e) => post('/api/auto', { enabled: e.target.checked });

function connect() {
  const es = new EventSource('/api/stream');
  es.onmessage = (ev) => { S = JSON.parse(ev.data); render(); };
  es.onerror = () => { $('conn').textContent = 'reconnecting…'; $('conn').className = 'pill bad'; };
}
connect();
setInterval(render, 1000);
