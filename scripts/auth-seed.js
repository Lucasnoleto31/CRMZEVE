#!/usr/bin/env node
/**
 * Seed dos 3 usuários iniciais do CRM.
 *
 *  Pré-requisitos:
 *    - SQL database/auth-users.sql já rodado no Supabase (cria trigger
 *      on_auth_user_created que popula crm_users automaticamente).
 *
 *  Uso:
 *    SUPABASE_URL=https://SEU-PROJETO.supabase.co \
 *    SUPABASE_SERVICE_KEY=SUA_SERVICE_ROLE_KEY \
 *    SEED_PASSWORD='Zeve@2026' \
 *    node scripts/auth-seed.js
 *
 *  (Se você tem .env na raiz ou em bot/, o script carrega automaticamente.)
 *
 *  Idempotente: se o usuário já existe no Supabase Auth, pula sem erro.
 *  Ajusta o role/name na crm_users em todo caso.
 */

try { require('dotenv').config(); } catch { /* opcional */ }
try { require('dotenv').config({ path: require('path').join(__dirname, '..', 'bot', '.env') }); } catch {}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET;
const PASSWORD     = process.env.SEED_PASSWORD;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('❌ SUPABASE_URL e SUPABASE_SERVICE_KEY são obrigatórios.');
  process.exit(1);
}
if (!PASSWORD) {
  console.error('❌ SEED_PASSWORD não definido. Exemplo:');
  console.error("   SEED_PASSWORD='Zeve@2026' node scripts/auth-seed.js");
  process.exit(1);
}

// Usuários iniciais. Depois que rodar, mude senhas via UI/painel.
const USERS = [
  { email: 'lucas@zeve.com.br', name: 'Lucas', role: 'admin' },
  { email: 'artur@zeve.com.br', name: 'Artur', role: 'reunioes' },
  { email: 'aikon@zeve.com.br', name: 'Aikon', role: 'vendedor' },
];

// ── Helpers sobre a Admin API do Supabase ────────────────────────────
const base = SUPABASE_URL.replace(/\/$/, '');
const adminHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function adminFetch(path, opts = {}) {
  const res = await fetch(`${base}${path}`, { ...opts, headers: { ...adminHeaders, ...(opts.headers || {}) } });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    const msg = body?.msg || body?.message || body?.error_description || body?.error || JSON.stringify(body).slice(0, 200);
    throw Object.assign(new Error(`${res.status} ${msg}`), { status: res.status, body });
  }
  return body;
}

async function findUserByEmail(email) {
  // Admin API lista os usuários do Auth
  const data = await adminFetch(`/auth/v1/admin/users?per_page=200`);
  const list = data?.users || data || [];
  return list.find(u => (u.email || '').toLowerCase() === email.toLowerCase()) || null;
}

async function createUser({ email, name, role }) {
  return adminFetch('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password: PASSWORD,
      email_confirm: true,                        // pula verificação de e-mail
      user_metadata: { name, role },              // trigger usa esses campos
    }),
  });
}

async function updateUserMetadata(userId, { name, role }) {
  return adminFetch(`/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    body: JSON.stringify({ user_metadata: { name, role } }),
  });
}

// Força o refresh da linha na crm_users caso o trigger não rode (ex.: sql
// foi aplicado DEPOIS que o usuário existia). Usa a REST API do PostgREST.
async function upsertCrmUser(userId, email, name, role) {
  const res = await fetch(`${base}/rest/v1/crm_users?on_conflict=id`, {
    method: 'POST',
    headers: {
      ...adminHeaders,
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ id: userId, email, name, role, active: true }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`upsert crm_users ${res.status}: ${t.slice(0, 200)}`);
  }
}

// ── Execução ─────────────────────────────────────────────────────────
(async () => {
  console.log(`🌱 Seed de ${USERS.length} usuários em ${SUPABASE_URL}\n`);
  let created = 0, updated = 0, skipped = 0;

  for (const u of USERS) {
    try {
      const existing = await findUserByEmail(u.email);
      if (existing) {
        await updateUserMetadata(existing.id, { name: u.name, role: u.role });
        await upsertCrmUser(existing.id, u.email, u.name, u.role);
        console.log(`↺ ${u.email} já existia — metadata/role atualizados (${u.role})`);
        updated++;
      } else {
        const created = await createUser(u);
        const id = created?.id || created?.user?.id;
        if (!id) throw new Error(`resposta sem id: ${JSON.stringify(created).slice(0, 200)}`);
        await upsertCrmUser(id, u.email, u.name, u.role);
        console.log(`✅ ${u.email} criado (role=${u.role})`);
      }
      created++;
    } catch (e) {
      console.error(`❌ ${u.email}: ${e.message}`);
      skipped++;
    }
  }

  console.log(`\nResumo: ${created} ok, ${updated} atualizados, ${skipped} erros.`);
  console.log('\n⚠️  Compartilhe a senha inicial só por canal privado.');
  console.log('   Avise a equipe para trocar ao primeiro login.');
})();
