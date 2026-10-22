// WhatsApp bot: links the store's own WhatsApp number (QR code, like WhatsApp Web), posts the
// exchange rate to one group on a fixed interval and answers "tabela sp" / "tabela py".
const QRCode = require('qrcode');
const pino = require('pino');
const { pool } = require('./db');

const TZ = () => process.env.TZ_LOJA || 'America/Asuncion';
const nNum = (v, d = 2) => (+v || 0).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const nMoney = (v, cur) => (cur === 'BRL' ? 'R$ ' : 'US$ ') + nNum(v);
const rateTxt = v => nNum(v, 4).replace(/0{1,2}$/, '');
const r2 = n => Math.round((+n || 0) * 100) / 100;
const hhmm = (d = new Date()) => d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: TZ() });
const ddmm = (d = new Date()) => d.toLocaleDateString('pt-BR', { timeZone: TZ() });

let B = null;          // the Baileys module, loaded on first use (it is an ES module)
let sock = null;
const st = { status: 'desconectado', qr: null, numero: null, nome: null, erro: null, grupos: [] };
let pairing = false, retries = 0, sawQr = false, onChange = () => {};

async function settings() {
  await pool.query('insert into settings (id) values (1) on conflict (id) do nothing');
  const { rows } = await pool.query('select cotacao, bot from settings where id=1');
  return rows[0];
}
const config = async () => ({ ativo: false, grupo: '', grupoNome: '', intervalo: 30, ...((await settings()).bot || {}) });
async function saveConfig(patch) {
  const c = { ...(await config()), ...patch };
  await pool.query('update settings set bot=$1 where id=1', [JSON.stringify(c)]);
  onChange();
  return c;
}

/* ---------- login kept in the database, so a redeploy does not ask for the QR code again ---------- */
async function dbAuthState() {
  const { BufferJSON, initAuthCreds, proto } = B;
  const read = async k => {
    const { rows } = await pool.query('select v from bot_auth where k=$1', [k]);
    return rows[0] ? JSON.parse(rows[0].v, BufferJSON.reviver) : null;
  };
  const write = (k, v) => pool.query('insert into bot_auth (k, v) values ($1,$2) on conflict (k) do update set v=excluded.v', [k, JSON.stringify(v, BufferJSON.replacer)]);
  const creds = (await read('creds')) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          await Promise.all(ids.map(async id => {
            let v = await read(`${type}-${id}`);
            if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
            out[id] = v;
          }));
          return out;
        },
        set: async data => {
          const jobs = [];
          for (const cat in data) for (const id in data[cat]) {
            const v = data[cat][id], k = `${cat}-${id}`;
            jobs.push(v ? write(k, v) : pool.query('delete from bot_auth where k=$1', [k]));
          }
          await Promise.all(jobs);
        },
      },
    },
    saveCreds: () => write('creds', creds),
  };
}
const hasLogin = async () => (await pool.query(`select 1 from bot_auth where k='creds' and v like '%"me":%'`)).rows.length > 0;

/* ---------- messages ---------- */
async function rateMessage() {
  const s = await settings();
  if (!s.cotacao) return null;
  return `💱 A taxa atual é: R$ ${rateTxt(s.cotacao)}`;
}
// same layout as the "Tabela WhatsApp" tab: Paraguay in dollars, São Paulo in reais, only what is in stock there
async function tableMessage(loja) {
  const cur = loja === 'PY' ? 'USD' : 'BRL', s = await settings(), rate = +s.cotacao || 0;
  const { rows } = await pool.query(`select codigo, nome, grupo, preco_usd, preco_brl from products where ativo and ${loja === 'PY' ? 'estoque_py' : 'estoque_sp'} > 0`);
  const price = p => (cur === 'USD' ? +p.preco_usd || 0 : +p.preco_brl || (rate ? r2(+p.preco_usd * rate) : 0));
  const gOf = p => (p.grupo || '').trim() || 'Outros';
  const L = rows.filter(p => price(p) > 0).sort((a, b) => gOf(a).localeCompare(gOf(b), 'pt-BR') || a.nome.localeCompare(b.nome, 'pt-BR'));
  const out = [`*TABELA DE PREÇOS · ${loja === 'PY' ? 'PARAGUAY · US$' : 'SÃO PAULO · R$'}*`, `_Atualizada em ${ddmm()} às ${hhmm()}${rate ? ' · Câmbio R$ ' + rateTxt(rate) : ''}_`, ''];
  if (!L.length) out.push('Nenhum produto disponível no momento.');
  const groups = L.some(p => (p.grupo || '').trim()); let last = null;
  for (const p of L) {
    if (groups && gOf(p) !== last) { last = gOf(p); out.push((out[out.length - 1] === '' ? '' : '\n') + `*${last.toUpperCase()}*`); }
    out.push(`▪️ ${p.nome} — *${nMoney(price(p), cur)}*`);
  }
  out.push('', `_${L.length} produtos · valores sujeitos a alteração_`);
  return out.join('\n');
}
// "tabela sp", "Tabela PY", "tabela  são paulo"...
function command(text) {
  const t = String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  const m = t.match(/^tabela (sp|py|sao paulo|paraguay|paraguai|br|brasil)$/);
  if (!m) return null;
  return /^(py|paraguay|paraguai)$/.test(m[1]) ? 'PY' : 'SP';
}
const textOf = m => {
  const msg = m.message?.ephemeralMessage?.message || m.message?.viewOnceMessage?.message || m.message || {};
  return msg.conversation || msg.extendedTextMessage?.text || '';
};

async function send(jid, text) {
  if (!sock || st.status !== 'conectado') throw new Error('O bot não está conectado ao WhatsApp.');
  await sock.sendMessage(jid, { text });
}

/* ---------- connection ---------- */
async function connect() {
  if (sock) return;
  B = B || await import('@whiskeysockets/baileys');
  const makeWASocket = B.makeWASocket || B.default;
  const { state, saveCreds } = await dbAuthState();
  st.status = 'conectando'; st.erro = null; onChange();
  const s = makeWASocket({ auth: state, logger: pino({ level: 'silent' }), browser: ['Sistema TRW', 'Chrome', '1.0'], markOnlineOnConnect: false, syncFullHistory: false });
  sock = s;
  s.ev.on('creds.update', saveCreds);
  s.ev.on('connection.update', async u => {
    if (u.qr) { sawQr = true; st.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 280 }); st.status = 'qr'; onChange(); }
    if (u.connection === 'open') {
      retries = 0; pairing = false; st.status = 'conectado'; st.qr = null; st.erro = null;
      st.numero = (s.user?.id || '').split(':')[0].split('@')[0]; st.nome = s.user?.name || '';
      console.log('Bot WhatsApp conectado:', st.numero);
      loadGroups().catch(() => {});
      onChange();
    }
    if (u.connection === 'close') {
      sock = null; st.qr = null;
      const code = u.lastDisconnect?.error?.output?.statusCode;
      console.log('Bot WhatsApp: conexão fechada', code || '', u.lastDisconnect?.error?.message || '');
      if (code === B.DisconnectReason.loggedOut) {
        await pool.query('delete from bot_auth');
        Object.assign(st, { status: 'desconectado', numero: null, nome: null, grupos: [], erro: 'O WhatsApp foi desconectado pelo celular. Conecte de novo lendo o QR code.' });
        pairing = false; onChange(); return;
      }
      // a fresh QR code expires after a few tries; stop asking until someone clicks Conectar again
      const keep = (await hasLogin()) || (pairing && retries < 4);
      retries += 1;
      st.status = keep ? 'conectando' : 'desconectado';
      if (!keep) { pairing = false; st.erro = sawQr ? 'O QR code expirou. Clique em Conectar para gerar outro.' : 'Não foi possível falar com o WhatsApp agora. Tente Conectar de novo em alguns minutos.'; }
      onChange();
      if (keep) setTimeout(() => connect().catch(e => console.error('Bot WhatsApp:', e.message)), Math.min(30000, 2000 * retries));
    }
  });
  s.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      const jid = m.key.remoteJid || '', loja = command(textOf(m));
      if (!loja || jid === 'status@broadcast') continue;
      // in groups the bot only answers in the group chosen in the system; private chats always get an answer
      if (jid.endsWith('@g.us') && jid !== (await config()).grupo) continue;
      try { await s.sendMessage(jid, { text: await tableMessage(loja) }, { quoted: m }); }
      catch (e) { console.error('Bot WhatsApp: falha ao enviar tabela:', e.message); }
    }
  });
}
async function loadGroups() {
  if (!sock || st.status !== 'conectado') return st.grupos;
  const all = await sock.groupFetchAllParticipating();
  st.grupos = Object.values(all).map(g => ({ id: g.id, nome: g.subject || g.id })).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  onChange();
  return st.grupos;
}
async function pair() {
  pairing = true; retries = 0; sawQr = false; st.erro = null;
  if (sock && st.status !== 'conectado') { try { sock.end(); } catch (e) {} sock = null; }
  await connect();
}
async function logout() {
  pairing = false;
  if (sock) { try { await sock.logout(); } catch (e) {} try { sock.end(); } catch (e) {} sock = null; }
  await pool.query('delete from bot_auth');
  Object.assign(st, { status: 'desconectado', qr: null, numero: null, nome: null, grupos: [], erro: null });
  onChange();
}

/* ---------- exchange rate post on a fixed clock (xx:00 and xx:30 for 30 minutes) ---------- */
let lastSlot = null;
async function tick() {
  const c = await config();
  if (!c.ativo || !c.grupo || st.status !== 'conectado') return;
  const every = Math.max(5, +c.intervalo || 30) * 60000, slot = Math.floor(Date.now() / every);
  if (lastSlot === null) lastSlot = c.ultimoSlot ?? slot - 1;
  if (slot === lastSlot) return;
  const text = await rateMessage();
  if (!text) return;
  lastSlot = slot;
  await send(c.grupo, text);
  await saveConfig({ ultimoSlot: slot, ultimoEnvio: Date.now() });
}

async function start(changed) {
  onChange = changed || onChange;
  await pool.query('create table if not exists bot_auth (k text primary key, v text not null)');
  await pool.query(`alter table settings add column if not exists bot jsonb not null default '{}'::jsonb`);
  if (process.env.WHATSAPP_BOT === 'off') return;
  if (await hasLogin()) connect().catch(e => { st.erro = e.message; console.error('Bot WhatsApp:', e.message); });
  setInterval(() => tick().catch(e => console.error('Bot WhatsApp: falha ao enviar câmbio:', e.message)), 30000);
}
const status = async () => ({ ...st, config: await config() });

module.exports = { start, status, pair, logout, loadGroups, saveConfig, send, rateMessage, tableMessage, command };
