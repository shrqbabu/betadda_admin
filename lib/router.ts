// lib/router.ts
// Central router: normalizes updates → dispatches to modules.
// All flows use inline keyboards. Slash commands: /start /home /cancel.

import { telegram, kb, backHomeRow } from './telegram';
import { CB, parseCallback } from './callbacks';
import { sessionStore } from './session';
import { walletService } from './wallet';
import { usersService } from './users';
import { depositService } from './deposit';
import { withdrawService } from './withdraw';
import { gameService, GAME_LABELS, type GameKind } from './games';
import { redeemService } from './redeem';
import { reportsService } from './reports';
import { broadcastService, type BroadcastInput, type BroadcastMediaType } from './broadcast';
import {
  aiService,
  askAgent,
  type AgentTurn, type WriteToolName,
} from './ai';
import { prefsStore } from './prefs';
import { backupService } from './backup';
import { config } from './config';
import { MODELS } from './models';
import { adminLogs } from './logs';
import { escapeHtml, makeIdempotencyKey, toMoney, truncate } from './utils';
import { logger } from './logger';
import type { TelegramUpdate, TelegramMessage, TelegramCallbackQuery, InlineKeyboardButton } from '../types/telegram';
import type { WalletAction, WalletBalanceType, WalletTxType } from '../types/wallet';

// ─── Home ───────────────────────────────────────────────────────────────────
const HOME_TEXT = ['🏠 <b>Admin Panel</b>', '', 'Select a module:'].join('\n');
function homeKeyboard() {
  return kb.build([
    [kb.button('👥 Users',     CB.usersMenu), kb.button('💰 Wallet',    CB.wallet)],
    [kb.button('💳 Add Fund',  CB.deposit),   kb.button('🏦 Withdraw',  CB.withdraw)],
    [kb.button('🎮 Games',     CB.games),     kb.button('🎁 Redeem',    CB.redeem)],
    [kb.button('📊 Reports',   CB.reports),   kb.button('📢 Broadcast', CB.broadcast)],
    [kb.button('🤖 AI',        CB.ai),        kb.button('⚙ Server',    CB.server)],
    [kb.button('📋 Logs',      CB.logs),      kb.button('💾 Backup',    CB.backupMenu)],
  ]);
}

async function showHome(chatId: number, messageId?: number): Promise<void> {
  if (messageId) {
    await telegram.editMessageText({ chat_id: chatId, message_id: messageId, text: HOME_TEXT, reply_markup: homeKeyboard() })
      .catch(async () => { await telegram.sendMessage({ chat_id: chatId, text: HOME_TEXT, reply_markup: homeKeyboard() }); });
  } else {
    await telegram.sendMessage({ chat_id: chatId, text: HOME_TEXT, reply_markup: homeKeyboard() });
  }
}

async function sendOrEdit(chatId: number, text: string, keyboard: ReturnType<typeof kb.build>, messageId?: number): Promise<void> {
  if (messageId) {
    try { await telegram.editMessageText({ chat_id: chatId, message_id: messageId, text, reply_markup: keyboard }); return; }
    catch { /* fall through */ }
  }
  await telegram.sendMessage({ chat_id: chatId, text, reply_markup: keyboard });
}

// ─── Views ──────────────────────────────────────────────────────────────────
function usersMenuView() {
  return {
    text: '👥 <b>Users</b>\n\nSearch by email, phone, or UID.',
    keyboard: kb.build([[kb.button('🔎 Search User', CB.usersSearch)], backHomeRow(CB.home)]),
  };
}
function walletMenuView() {
  return {
    text: '💰 <b>Wallet</b>\n\nLook up a user, then add/deduct across any balance type.',
    keyboard: kb.build([[kb.button('🔎 Lookup User', CB.walletLookup)], backHomeRow(CB.home)]),
  };
}
function reportsMenuView() {
  return {
    text: '📊 <b>Reports</b>',
    keyboard: kb.build([
      [kb.button('👥 Users',   CB.reportUsers),   kb.button('💵 Revenue', CB.reportRevenue)],
      [kb.button('💳 Deposit', CB.reportDeposit), kb.button('🏦 Withdraw',CB.reportWithdraw)],
      [kb.button('💰 Wallets', CB.reportWallet),  kb.button('🎮 Games',   CB.reportGames)],
      backHomeRow(CB.home),
    ]),
  };
}
function broadcastMenuView() {
  return {
    text: '📢 <b>Broadcast</b>\n\nChoose media type:',
    keyboard: kb.build([
      [kb.button('📝 Text',  CB.broadcastText), kb.button('🖼 Image', CB.broadcastImage)],
      [kb.button('🎞 Video', CB.broadcastVideo),kb.button('📄 PDF',   CB.broadcastPdf)],
      backHomeRow(CB.home),
    ]),
  };
}
function aiMenuView() {
  return {
    text: '🤖 <b>AI</b>\n\n<b>🪄 Agent</b> = natural language admin (create codes, approve/reject, ban, etc.).',
    keyboard: kb.build([
      [kb.button('🪄 Agent', CB.aiAgent)],
      [kb.button('💬 Chat', CB.aiChat), kb.button('💻 Code', CB.aiCode)],
      [kb.button('📋 Logs', CB.aiLogs), kb.button('🐛 Debug',CB.aiDebug)],
      [kb.button('🎛 Model', CB.aiModel)],
      backHomeRow(CB.home),
    ]),
  };
}

// ─── Model picker (per-admin) ───────────────────────────────────────────────
// Short aliases avoid Telegram's 64-byte callback_data limit.
const NVIDIA_MODEL_CHOICES: Array<{ key: string; label: string; id: string }> = [
  { key: 'llama70',       label: 'Llama 3.3 70B',           id: MODELS.llama70 },
  { key: 'llama4Mav',     label: 'Llama 4 Maverick 17B',    id: MODELS.llama4Mav },
  { key: 'nemotron70',    label: 'Nemotron 70B',            id: MODELS.nemotron70 },
  { key: 'nemotronSuper', label: 'Nemotron Super 49B v1.5', id: MODELS.nemotronSuper },
  { key: 'nemotronUltra', label: 'Nemotron Ultra 253B',     id: MODELS.nemotronUltra },
  { key: 'nemotron3Sup',  label: 'Nemotron 3 Super 120B',   id: MODELS.nemotron3Sup },
  { key: 'qwen3Next',     label: 'Qwen3-Next 80B',          id: MODELS.qwen3Next },
  { key: 'qwen35Big',     label: 'Qwen 3.5 122B',           id: MODELS.qwen35Big },
  { key: 'deepseekPro',   label: 'DeepSeek V4 Pro',         id: MODELS.deepseekPro },
  { key: 'deepseekFlash', label: 'DeepSeek V4 Flash',       id: MODELS.deepseekFlash },
  { key: 'mistralLg3',    label: 'Mistral Large 3 675B',    id: MODELS.mistralLg3 },
  { key: 'gptOss120',     label: 'GPT-OSS 120B',            id: MODELS.gptOss120 },
  { key: 'gptOss20',      label: 'GPT-OSS 20B',             id: MODELS.gptOss20 },
  { key: 'kimi',          label: 'Kimi K2.6',               id: MODELS.kimi },
  { key: 'glm52',          label: 'GLM 5.2',                id: MODELS.glm52 },
  { key: 'gemma4',         label: 'Gemma 4 31B',            id: MODELS.gemma4 },
  { key: 'llama8',         label: 'Llama 3.1 8B (fast)',    id: MODELS.llama8 },
];
const OPENROUTER_MODEL_CHOICES: Array<{ key: string; label: string; id: string }> = [
  { key: 'gemFlashLite', label: 'Gemini 2.5 Flash-Lite', id: 'google/gemini-2.5-flash-lite' },
  { key: 'gemFlash',     label: 'Gemini 2.5 Flash',      id: 'google/gemini-2.5-flash' },
  { key: 'gpt4oMini',    label: 'GPT-4o Mini',           id: 'openai/gpt-4o-mini' },
  { key: 'llama70',      label: 'Llama 3.3 70B (free)',  id: 'meta-llama/llama-3.3-70b-instruct:free' },
  { key: 'qwen72',       label: 'Qwen 2.5 72B (free)',   id: 'qwen/qwen-2.5-72b-instruct:free' },
  { key: 'claudeHaiku',  label: 'Claude 3.5 Haiku',      id: 'anthropic/claude-3.5-haiku' },
];
function currentModelChoices() {
  return config.ai.provider === 'nvidia' ? NVIDIA_MODEL_CHOICES : OPENROUTER_MODEL_CHOICES;
}
function findModelByKey(key: string) {
  return currentModelChoices().find(c => c.key === key);
}

async function aiModelView(telegramId: number) {
  const prefs = await prefsStore.get(telegramId);
  const isNvidia = config.ai.provider === 'nvidia';
  const current = isNvidia
    ? (prefs?.nvidiaModel     || config.nvidia.model)
    : (prefs?.openrouterModel || config.openrouter.model);
  const choices = currentModelChoices();
  const rows = choices.map(c => [
    kb.button(`${c.id === current ? '🟢 ' : ''}${c.label}`, CB.aiPickModel(c.key)),
  ]);
  rows.push(backHomeRow(CB.ai));
  return {
    text: [
      '🎛 <b>AI Model</b>',
      '',
      `Provider: <code>${escapeHtml(config.ai.provider)}</code>`,
      `Current: <code>${escapeHtml(current)}</code>`,
      '',
      'Model select karo — sirf tumhare account ke liye save hoga.',
    ].join('\n'),
    keyboard: kb.build(rows),
  };
}

async function handleAiPickModel(chatId: number, telegramId: number, key: string, msgId?: number): Promise<void> {
  const choice = findModelByKey(key);
  if (!choice) {
    const v = await aiModelView(telegramId);
    return sendOrEdit(chatId, `❌ Unknown model.\n\n${v.text}`, v.keyboard, msgId);
  }
  if (config.ai.provider === 'nvidia') {
    await prefsStore.set(telegramId, { nvidiaModel: choice.id });
  } else {
    await prefsStore.set(telegramId, { openrouterModel: choice.id });
  }
  await adminLogs.record({
    telegramId, module: 'ai', action: 'set_model', result: 'success',
    metadata: { provider: config.ai.provider, model: choice.id },
  });
  const v = await aiModelView(telegramId);
  return sendOrEdit(chatId, `✅ Model set to <b>${escapeHtml(choice.label)}</b>.\n\n${v.text}`, v.keyboard, msgId);
}
function serverInfoView() {
  const mem = process.memoryUsage();
  return {
    text: [
      '⚙ <b>Server</b>', '',
      `Node: <code>${escapeHtml(process.version)}</code>`,
      `Platform: <code>${escapeHtml(process.platform)}</code>`,
      `Uptime: <code>${Math.floor(process.uptime())}s</code>`,
      `RSS: <code>${Math.round(mem.rss / 1024 / 1024)} MB</code>`,
      `Heap: <code>${Math.round(mem.heapUsed / 1024 / 1024)} MB</code>`,
    ].join('\n'),
    keyboard: kb.build([backHomeRow(CB.home)]),
  };
}
function gamesMenuView() {
  return {
    text: '🎮 <b>Games</b>\n\nPick a game to manage tables:',
    keyboard: kb.build([
      [kb.button(GAME_LABELS.poker,   CB.gamePicker('poker')),  kb.button(GAME_LABELS.ludo,   CB.gamePicker('ludo'))],
      [kb.button(GAME_LABELS.joker,   CB.gamePicker('joker')),  kb.button(GAME_LABELS['9card'],CB.gamePicker('9card'))],
      [kb.button(GAME_LABELS.tambola, CB.gamePicker('tambola'))],
      backHomeRow(CB.home),
    ]),
  };
}
function redeemMenuView() {
  return {
    text: '🎁 <b>Redeem Codes</b>',
    keyboard: kb.build([
      [kb.button('➕ New Code', CB.redeemCreate)],
      [kb.button('🟢 Active',   CB.redeemActive), kb.button('📜 All', CB.redeemList)],
      backHomeRow(CB.home),
    ]),
  };
}

function backupMenuView() {
  return {
    text: [
      '💾 <b>Backup</b>',
      '',
      '<b>📤 Export</b> — full database ki JSON file yahin chat mein milegi.',
      '<b>📥 Import</b> — export wali file bhejo, dusre account mein restore ho jayega.',
      '',
      '<i>Account transfer: purane bot se Export → naye bot me Import.</i>',
    ].join('\n'),
    keyboard: kb.build([
      [kb.button('📤 Export Data', CB.backupExport), kb.button('📥 Import Data', CB.backupImport)],
      backHomeRow(CB.home),
    ]),
  };
}

// ─── Backup handlers ────────────────────────────────────────────────────────
async function handleBackupExport(chatId: number, telegramId: number): Promise<void> {
  await telegram.sendMessage({ chat_id: chatId, text: '📤 Export chal raha hai… bade database par 20-30 sec lag sakte hain.' });
  try {
    const { json, totalDocs, perCollection } = await backupService.exportAll();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const summary = Object.entries(perCollection)
      .filter(([, n]) => n > 0)
      .map(([c, n]) => `${c}: ${n}`)
      .join(', ');
    await telegram.sendDocumentContent(
      chatId,
      `backup-${stamp}.json`,
      json,
      `✅ <b>Export complete</b> — ${totalDocs} docs\n<i>${escapeHtml(truncate(summary, 300))}</i>\n\nIs file ko save rakho — Import isi se hoga.`
    );
    await adminLogs.record({ telegramId, module: 'backup', action: 'export', result: 'success', metadata: { totalDocs } });
  } catch (err) {
    const msg = (err as Error).message;
    await adminLogs.record({ telegramId, module: 'backup', action: 'export', result: 'failure', errorMessage: msg });
    await telegram.sendMessage({ chat_id: chatId, text: `❌ Export failed: ${escapeHtml(msg)}` });
  }
  const v = backupMenuView();
  await telegram.sendMessage({ chat_id: chatId, text: v.text, reply_markup: v.keyboard });
}

async function handleBackupFile(chatId: number, telegramId: number, msg: TelegramMessage): Promise<void> {
  const doc = msg.document;
  if (!doc) {
    await telegram.sendMessage({ chat_id: chatId, text: '📎 File attach karke bhejo (Export se mili .json file).\n\n/cancel to abort.' });
    return;
  }
  if (doc.file_size && doc.file_size > 19 * 1024 * 1024) {
    await telegram.sendMessage({ chat_id: chatId, text: '❌ File 20 MB se badi hai — Telegram bot itni badi file download nahi kar sakta.\nPC par <code>node scripts/import.js</code> use karo.' });
    return;
  }
  try {
    const buf = await telegram.downloadFile(doc.file_id);
    const json = buf.toString('utf8');
    const { manifest, total, nonEmpty } = backupService.inspect(json);

    // Store only the file_id (session doc has a 1 MiB Firestore limit) —
    // the file is re-downloaded from Telegram when the admin confirms.
    await sessionStore.set(telegramId, chatId, 'backup:await_confirm', { backupFileId: doc.file_id });
    const lines = nonEmpty.slice(0, 12).map(([c, n]) => `• ${escapeHtml(c)}: ${n}`);
    if (nonEmpty.length > 12) lines.push(`…aur ${nonEmpty.length - 12} collections`);
    await telegram.sendMessage({
      chat_id: chatId,
      text: [
        '📥 <b>Backup file mil gayi</b>',
        '',
        `Source project: <code>${escapeHtml(manifest.projectId)}</code>`,
        `Exported: ${escapeHtml(manifest.exportedAt)}`,
        `Total docs: <b>${total}</b>`,
        '',
        ...lines,
        '',
        '<b>Merge</b> = jo docs pehle se hain unhe skip karo (safe)',
        '<b>Overwrite</b> = backup ka data existing ke upar likh do ⚠️',
      ].join('\n'),
      reply_markup: kb.build([
        [kb.button('✅ Import (Merge-safe)', CB.backupImportMerge)],
        [kb.button('⚠️ Import (Overwrite)', CB.backupImportOverwrite)],
        [kb.button('❌ Cancel', CB.cancel)],
      ]),
    });
  } catch (err) {
    await telegram.sendMessage({ chat_id: chatId, text: `❌ ${escapeHtml((err as Error).message)}\n\nDobara file bhejo ya /cancel.` });
  }
}

async function handleBackupImportConfirm(chatId: number, telegramId: number, overwrite: boolean): Promise<void> {
  const session = await sessionStore.get(telegramId);
  const fileId = session?.context?.backupFileId;
  if (session?.state !== 'backup:await_confirm' || typeof fileId !== 'string') {
    await telegram.sendMessage({ chat_id: chatId, text: '❌ Session expire ho gaya — Backup menu se dobara file bhejo.' });
    return showHome(chatId);
  }
  await sessionStore.clear(telegramId);
  await telegram.sendMessage({ chat_id: chatId, text: `📥 Import chal raha hai (${overwrite ? 'overwrite' : 'merge-safe'})…` });
  try {
    const json = (await telegram.downloadFile(fileId)).toString('utf8');
    const { written, skipped, perCollection } = await backupService.importAll(json, overwrite);
    const lines = Object.entries(perCollection).map(([c, s]) => `• ${escapeHtml(c)}: ${escapeHtml(s)}`);
    await telegram.sendMessage({
      chat_id: chatId,
      text: [`✅ <b>Import complete</b> — ${written} written${skipped ? `, ${skipped} skipped` : ''}`, '', ...lines].join('\n'),
      reply_markup: kb.build([backHomeRow(CB.home)]),
    });
    await adminLogs.record({ telegramId, module: 'backup', action: overwrite ? 'import_overwrite' : 'import_merge', result: 'success', metadata: { written, skipped } });
  } catch (err) {
    const msg = (err as Error).message;
    await adminLogs.record({ telegramId, module: 'backup', action: 'import', result: 'failure', errorMessage: msg });
    await telegram.sendMessage({ chat_id: chatId, text: `❌ Import failed: ${escapeHtml(msg)}`, reply_markup: kb.build([backHomeRow(CB.home)]) });
  }
}

function renderUserCard(u: NonNullable<Awaited<ReturnType<typeof usersService.findByUid>>>) {
  const lines = [
    '👤 <b>User</b>', '',
    `<b>UID:</b> <code>${escapeHtml(u.uid)}</code>`,
    `<b>Name:</b> ${escapeHtml(u.displayName || '—')}`,
    `<b>Email:</b> ${escapeHtml(u.email || '—')}`,
    `<b>Phone:</b> ${escapeHtml(u.phone || '—')}`,
    `<b>Status:</b> ${escapeHtml(u.status)}`,
    `<b>Last Login:</b> ${u.lastLoginAt ? new Date(u.lastLoginAt).toISOString() : '—'}`,
  ];
  if (u.banReason) lines.push(`<b>Ban Reason:</b> ${escapeHtml(u.banReason)}`);
  return lines.join('\n');
}
function renderWalletCard(uid: string, w: Awaited<ReturnType<typeof walletService.getBalance>>) {
  if (!w) return `💰 <b>Wallet</b>\n\nNo wallet for <code>${escapeHtml(uid)}</code>.`;
  return [
    '💰 <b>Wallet</b>', '',
    `<b>UID:</b> <code>${escapeHtml(uid)}</code>`,
    `<b>Deposit:</b>  ₹${toMoney(w.depositBalance)}`,
    `<b>Winnings:</b> ₹${toMoney(w.winningBalance)}`,
    `<b>Bonus:</b>    ₹${toMoney(w.bonusBalance)}`,
    `<b>Referral:</b> ₹${toMoney(w.referralBalance)}`,
    `<b>Total:</b>    ₹${toMoney(w.totalBalance)}`,
  ].join('\n');
}

// ─── Entry ──────────────────────────────────────────────────────────────────
export async function handleUpdate(update: TelegramUpdate, telegramId: number): Promise<void> {
  try {
    if (update.callback_query) return await handleCallback(update.callback_query, telegramId);
    if (update.message)        return await handleMessage(update.message, telegramId);
  } catch (err) {
    logger.error('router.handle.error', { error: (err as Error).message, telegramId });
  }
}

/** Best-effort admin display name from a Telegram user object. */
function adminNameFromMsg(msg: TelegramMessage): string {
  const u = msg.from;
  if (!u) return '';
  const full = [u.first_name, (u as { last_name?: string }).last_name].filter(Boolean).join(' ').trim();
  return full || u.username || '';
}

// ─── Text messages ──────────────────────────────────────────────────────────
async function handleMessage(msg: TelegramMessage, telegramId: number): Promise<void> {
  const chatId = msg.chat.id;
  const text   = (msg.text || msg.caption || '').trim();

  if (text === '/start' || text === '/home' || text === '/menu') {
    await sessionStore.clear(telegramId);
    return showHome(chatId);
  }
  if (text === '/cancel') {
    await sessionStore.clear(telegramId);
    await telegram.sendMessage({ chat_id: chatId, text: '✅ Cancelled.' });
    return showHome(chatId);
  }

  const session = await sessionStore.get(telegramId);
  if (!session || session.state === 'idle') return showHome(chatId);

  // Inject the admin's Telegram display name into every session context so
  // handlers (redeem create, etc.) can attribute actions without extra prompts.
  const adminName = adminNameFromMsg(msg);
  const ctx = { ...session.context, adminName };

  switch (session.state) {
    case 'users:await_query':       return handleUsersQuery(chatId, telegramId, text);
    case 'users:await_edit_value':  return handleUsersEditValue(chatId, telegramId, text, ctx);
    case 'wallet:await_uid':        return handleWalletUid(chatId, telegramId, text);
    case 'wallet:await_amount':     return handleWalletAmount(chatId, telegramId, text, ctx);
    case 'wallet:await_description':return handleWalletDescription(chatId, telegramId, text, ctx);
    case 'withdraw:await_reject_reason': return handleWithdrawRejectReason(chatId, telegramId, text, ctx);
    case 'deposit:await_reject_reason':  return handleDepositRejectReason(chatId, telegramId, text, ctx);
    case 'broadcast:await_content':      return handleBroadcastContent(chatId, telegramId, msg, ctx);
    case 'games:await_create_form':      return handleGameCreateForm(chatId, telegramId, text, ctx);
    case 'games:await_kick_uid':         return handleGameKickUid(chatId, telegramId, text, ctx);
    case 'redeem:await_form':            return handleRedeemForm(chatId, telegramId, text, ctx);
    case 'ai:await_prompt':              return handleAiPrompt(chatId, telegramId, text, ctx);
    case 'ai:await_agent_prompt':        return handleAiAgentPrompt(chatId, telegramId, text, ctx);
    case 'backup:await_file':            return handleBackupFile(chatId, telegramId, msg);
    case 'backup:await_confirm': {
      await telegram.sendMessage({ chat_id: chatId, text: 'Upar wale buttons se choose karo — Merge, Overwrite ya Cancel.' });
      return;
    }
    default:
      await sessionStore.clear(telegramId);
      return showHome(chatId);
  }
}

// ─── Callback dispatcher ────────────────────────────────────────────────────
async function handleCallback(cb: TelegramCallbackQuery, telegramId: number): Promise<void> {
  const data   = cb.data || '';
  const chatId = cb.message?.chat.id;
  const msgId  = cb.message?.message_id;
  if (!chatId) {
    await telegram.answerCallbackQuery({ callback_query_id: cb.id, text: 'Session expired', show_alert: true });
    return;
  }
  await telegram.answerCallbackQuery({ callback_query_id: cb.id }).catch(() => {});

  const p = parseCallback(data);

  // Navigation
  if (data === CB.home || data === CB.cancel) { await sessionStore.clear(telegramId); return showHome(chatId, msgId); }
  if (data === CB.usersMenu) { const v = usersMenuView();     return sendOrEdit(chatId, v.text, v.keyboard, msgId); }
  if (data === CB.wallet)    { const v = walletMenuView();    return sendOrEdit(chatId, v.text, v.keyboard, msgId); }
  if (data === CB.reports)   { const v = reportsMenuView();   return sendOrEdit(chatId, v.text, v.keyboard, msgId); }
  if (data === CB.broadcast) { const v = broadcastMenuView(); return sendOrEdit(chatId, v.text, v.keyboard, msgId); }
  if (data === CB.ai)        { const v = aiMenuView();        return sendOrEdit(chatId, v.text, v.keyboard, msgId); }
  if (data === CB.server)    { const v = serverInfoView();    return sendOrEdit(chatId, v.text, v.keyboard, msgId); }
  if (data === CB.games)     { const v = gamesMenuView();     return sendOrEdit(chatId, v.text, v.keyboard, msgId); }
  if (data === CB.redeem)    { const v = redeemMenuView();    return sendOrEdit(chatId, v.text, v.keyboard, msgId); }

  // Backup (export/import)
  if (data === CB.backupMenu) { await sessionStore.clear(telegramId); const v = backupMenuView(); return sendOrEdit(chatId, v.text, v.keyboard, msgId); }
  if (data === CB.backupExport) return handleBackupExport(chatId, telegramId);
  if (data === CB.backupImport) {
    await sessionStore.set(telegramId, chatId, 'backup:await_file');
    return void telegram.sendMessage({ chat_id: chatId, text: '📥 Export se mili <b>backup .json file</b> yahan bhejo (document ki tarah attach karke).\n\n/cancel to abort.' });
  }
  if (data === CB.backupImportMerge)     return handleBackupImportConfirm(chatId, telegramId, false);
  if (data === CB.backupImportOverwrite) return handleBackupImportConfirm(chatId, telegramId, true);

  // Users
  if (data === CB.usersSearch) {
    await sessionStore.set(telegramId, chatId, 'users:await_query');
    return void telegram.sendMessage({ chat_id: chatId, text: '🔎 Send email, phone (E.164) or UID.\n\n/cancel to abort.' });
  }
  if (p.module === 'user' && p.args.length > 0) {
    return handleUserAction(chatId, telegramId, p.action, p.args[0]!, msgId);
  }

  // Wallet
  if (data === CB.walletLookup) {
    await sessionStore.set(telegramId, chatId, 'wallet:await_uid');
    return void telegram.sendMessage({ chat_id: chatId, text: '💰 Send UID / email / phone.\n\n/cancel to abort.' });
  }
  if (p.module === 'wallet' && (p.action === 'add' || p.action === 'ded') && p.args[0]) {
    return promptBalanceType(chatId, p.action, p.args[0]!);
  }
  if (p.module === 'wallet' && p.action === 'pb' && p.args.length >= 3) {
    return startWalletFlow(chatId, telegramId, p.args[0] as 'add' | 'ded', p.args[1]!, p.args[2] as WalletBalanceType);
  }
  if (data === CB.walletConfirm) return executeWalletConfirmed(chatId, telegramId, msgId);

  // Deposit (add-fund) — pass admin's Telegram display name so it flows into
  // asignBy when a redeem code is generated from a deposit request.
  const cbAdminName = cb.from
    ? ([cb.from.first_name, (cb.from as { last_name?: string }).last_name].filter(Boolean).join(' ').trim() || cb.from.username || '')
    : '';
  if (data === CB.deposit || data === CB.depositPending) return renderDepositList(chatId, msgId, 'pending');
  if (data === CB.depositHistory)                        return renderDepositList(chatId, msgId, 'history');
  if (p.module === 'dep' && p.args[0]) return handleDepositAction(chatId, telegramId, p.action, p.args[0], msgId, cbAdminName);

  // Withdraw
  if (data === CB.withdraw || data === CB.withdrawPending) return renderWithdrawList(chatId, msgId, 'pending');
  if (data === CB.withdrawHistory)                         return renderWithdrawList(chatId, msgId, 'history');
  if (p.module === 'wd' && p.args[0]) return handleWithdrawAction(chatId, telegramId, p.action, p.args[0], msgId);

  // Games
  if (p.module === 'game') return handleGameCallback(chatId, telegramId, p.action, p.args, msgId);

  // Redeem
  if (p.module === 'rd') return handleRedeemCallback(chatId, telegramId, p.action, p.args, msgId);

  // Reports
  if (p.module === 'rep') return handleReport(chatId, msgId, p.action);

  // Broadcast
  if (p.module === 'bc') return handleBroadcastMenu(chatId, telegramId, p.action, msgId);

  // AI
  if (p.module === 'ai') {
    if (p.action === 'end')   return handleAiEndChat(chatId, telegramId, msgId);
    if (p.action === 'agent') return handleAiAgentStart(chatId, telegramId, msgId);
    if (p.action === 'aconf') return handleAiAgentConfirm(chatId, telegramId, cbAdminName || `Admin${telegramId}`, msgId);
    if (p.action === 'acan')  return handleAiAgentCancel(chatId, telegramId, msgId);
    if (p.action === 'amod')  return handleAiAgentModify(chatId, telegramId, msgId);
    if (p.action === 'model') {
      const v = await aiModelView(telegramId);
      return sendOrEdit(chatId, v.text, v.keyboard, msgId);
    }
    if (p.action === 'mp' && p.args[0]) return handleAiPickModel(chatId, telegramId, p.args[0], msgId);
    return handleAiMenu(chatId, telegramId, p.action, msgId);
  }

  // Logs
  if (data === CB.logs || data === CB.logsRecent) return renderLogs(chatId, msgId, 'recent');
  if (data === CB.logsMine)                       return renderLogs(chatId, msgId, 'mine', telegramId);

  await showHome(chatId, msgId);
}

// ─── Users flow ─────────────────────────────────────────────────────────────
async function handleUsersQuery(chatId: number, telegramId: number, query: string): Promise<void> {
  const user = await usersService.search(query);
  await sessionStore.clear(telegramId);
  if (!user) {
    return void telegram.sendMessage({
      chat_id: chatId, text: '❌ User not found.',
      reply_markup: kb.build([backHomeRow(CB.usersMenu)]),
    });
  }
  await telegram.sendMessage({
    chat_id: chatId, text: renderUserCard(user),
    reply_markup: buildUserKeyboard(user.uid, user.status === 'banned'),
  });
}

function buildUserKeyboard(uid: string, isBanned: boolean) {
  const banRow: InlineKeyboardButton[] = isBanned
    ? [kb.button('✅ Unban', CB.userUnbanAsk(uid))]
    : [kb.button('🚫 Ban',   CB.userBanAsk(uid))];
  return kb.build([
    [kb.button('💰 Wallet', CB.userWallet(uid)), kb.button('📄 Profile', CB.userProfile(uid))],
    [kb.button('✏️ Name', CB.userEditName(uid)), kb.button('📧 Email', CB.userEditEmail(uid)), kb.button('📞 Phone', CB.userEditPhone(uid))],
    banRow,
    [kb.button('🎮 Games', CB.userGames(uid)), kb.button('📜 Tx', CB.userTx(uid))],
    [kb.button('🗑 Delete', CB.userDeleteAsk(uid))],
    backHomeRow(CB.usersMenu),
  ]);
}

async function handleUserAction(chatId: number, telegramId: number, action: string, uid: string, msgId?: number): Promise<void> {
  const user = await usersService.findByUid(uid);
  if (!user) return sendOrEdit(chatId, '❌ User not found.', kb.build([backHomeRow(CB.usersMenu)]), msgId);

  switch (action) {
    case 'v':
    case 'p':
      return sendOrEdit(chatId, renderUserCard(user), buildUserKeyboard(uid, user.status === 'banned'), msgId);

    case 'w': {
      const w = await walletService.getBalance(uid);
      return sendOrEdit(chatId, renderWalletCard(uid, w), kb.build([
        [kb.button('➕ Add', CB.walletAdd(uid)), kb.button('➖ Deduct', CB.walletDeduct(uid))],
        [kb.button('📜 Tx', CB.userTx(uid))],
        backHomeRow(CB.userView(uid)),
      ]), msgId);
    }

    case 'en': case 'em': case 'eph': {
      const fieldMap: Record<string, 'displayName' | 'email' | 'phone'> = {
        en: 'displayName', em: 'email', eph: 'phone',
      };
      const field = fieldMap[action]!;
      await sessionStore.set(telegramId, chatId, 'users:await_edit_value', { uid, field });
      const labelMap: Record<string, string> = { displayName: 'name', email: 'email', phone: 'phone (E.164)' };
      return void telegram.sendMessage({
        chat_id: chatId,
        text: `✏️ Send the new <b>${labelMap[field]}</b> for <code>${escapeHtml(uid)}</code>.\n\n/cancel to abort.`,
        parse_mode: 'HTML',
      });
    }

    case 'ba': return sendOrEdit(chatId,
      `⚠️ Confirm <b>BAN</b> <code>${escapeHtml(uid)}</code>?`,
      kb.build([[kb.button('✅ Confirm', CB.userBanConfirm(uid)), kb.button('❌ Cancel', CB.userView(uid))]]), msgId);
    case 'bc': {
      await usersService.ban(uid, 'Banned via admin panel', telegramId);
      await adminLogs.record({ telegramId, module: 'users', action: 'ban', target: uid, result: 'success' });
      const fresh = await usersService.findByUid(uid);
      return sendOrEdit(chatId, `🚫 Banned.\n\n${renderUserCard(fresh!)}`, buildUserKeyboard(uid, true), msgId);
    }
    case 'ua': return sendOrEdit(chatId,
      `⚠️ Confirm <b>UNBAN</b> <code>${escapeHtml(uid)}</code>?`,
      kb.build([[kb.button('✅ Confirm', CB.userUnbanConfirm(uid)), kb.button('❌ Cancel', CB.userView(uid))]]), msgId);
    case 'uc': {
      await usersService.unban(uid, telegramId);
      await adminLogs.record({ telegramId, module: 'users', action: 'unban', target: uid, result: 'success' });
      const fresh = await usersService.findByUid(uid);
      return sendOrEdit(chatId, `✅ Unbanned.\n\n${renderUserCard(fresh!)}`, buildUserKeyboard(uid, false), msgId);
    }
    case 'da': return sendOrEdit(chatId,
      `⚠️ Confirm <b>DELETE</b> <code>${escapeHtml(uid)}</code>? This removes the user doc + auth.`,
      kb.build([[kb.button('🗑 Confirm Delete', CB.userDeleteConfirm(uid)), kb.button('❌ Cancel', CB.userView(uid))]]), msgId);
    case 'dc': {
      const r = await usersService.remove(uid, telegramId);
      await adminLogs.record({ telegramId, module: 'users', action: 'delete', target: uid, result: r.ok ? 'success' : 'failure' });
      return sendOrEdit(chatId, r.ok ? '🗑 User deleted.' : `❌ ${escapeHtml(r.error)}`, kb.build([backHomeRow(CB.usersMenu)]), msgId);
    }

    case 'g': {
      const games = await usersService.recentGames(uid, 10);
      const lines = games.length
        ? games.map(g => `• ${escapeHtml(g.game)} — ${escapeHtml(g.result)} — ₹${toMoney(g.amount)}`).join('\n')
        : '<i>No recent games.</i>';
      return sendOrEdit(chatId, `🎮 <b>Recent Games</b>\n\n${lines}`, kb.build([backHomeRow(CB.userView(uid))]), msgId);
    }
    case 't': {
      const txs = await usersService.recentTransactions(uid, 10);
      const lines = txs.length
        ? txs.map(t => {
            const amount = Number(t.amount || 0);
            return `• ${escapeHtml(String(t.action || ''))} ₹${toMoney(Math.abs(amount))} ${escapeHtml(String(t.balanceType || ''))} — ${escapeHtml(String(t.type || ''))} — ${escapeHtml(truncate(String(t.description || ''), 40))}`;
          }).join('\n')
        : '<i>No transactions.</i>';
      return sendOrEdit(chatId, `📜 <b>Recent Transactions</b>\n\n${lines}`, kb.build([backHomeRow(CB.userView(uid))]), msgId);
    }
    default:
      return sendOrEdit(chatId, renderUserCard(user), buildUserKeyboard(uid, user.status === 'banned'), msgId);
  }
}

async function handleUsersEditValue(chatId: number, telegramId: number, value: string, ctx: Record<string, unknown>): Promise<void> {
  const uid   = String(ctx.uid || '');
  const field = String(ctx.field || 'displayName') as 'displayName' | 'email' | 'phone';
  await sessionStore.clear(telegramId);
  const r = await usersService.updateField(uid, field, value.trim());
  await adminLogs.record({
    telegramId, module: 'users', action: `edit_${field}`, target: uid,
    description: value.slice(0, 100), result: r.ok ? 'success' : 'failure',
    errorMessage: r.ok ? undefined : r.error,
  });
  const user = await usersService.findByUid(uid);
  await telegram.sendMessage({
    chat_id: chatId,
    text: r.ok ? `✅ Updated.\n\n${renderUserCard(user!)}` : `❌ ${r.error}`,
    reply_markup: buildUserKeyboard(uid, user?.status === 'banned'),
  });
}

// ─── Wallet flow ─────────────────────────────────────────────────────────────
async function handleWalletUid(chatId: number, telegramId: number, query: string): Promise<void> {
  const user = await usersService.search(query);
  await sessionStore.clear(telegramId);
  if (!user) {
    return void telegram.sendMessage({ chat_id: chatId, text: '❌ User not found.',
      reply_markup: kb.build([backHomeRow(CB.wallet)]) });
  }
  const w = await walletService.getOrCreate(user.uid);
  await telegram.sendMessage({
    chat_id: chatId, text: renderWalletCard(user.uid, w),
    reply_markup: kb.build([
      [kb.button('➕ Add', CB.walletAdd(user.uid)), kb.button('➖ Deduct', CB.walletDeduct(user.uid))],
      [kb.button('📜 Tx', CB.userTx(user.uid))],
      backHomeRow(CB.wallet),
    ]),
  });
}

async function promptBalanceType(chatId: number, op: 'add' | 'ded', uid: string): Promise<void> {
  const label = op === 'add' ? '➕ ADD' : '➖ DEDUCT';
  const text  = `${label} to which balance for <code>${escapeHtml(uid)}</code>?`;
  await telegram.sendMessage({
    chat_id: chatId, text, parse_mode: 'HTML',
    reply_markup: kb.build([
      [kb.button('💳 Deposit',  CB.walletPickBalance(op, uid, 'depositBalance')),
       kb.button('🏆 Winning', CB.walletPickBalance(op, uid, 'winningBalance'))],
      [kb.button('🎁 Bonus',   CB.walletPickBalance(op, uid, 'bonusBalance')),
       kb.button('👥 Referral',CB.walletPickBalance(op, uid, 'referralBalance'))],
      backHomeRow(CB.userWallet(uid)),
    ]),
  });
}

async function startWalletFlow(chatId: number, telegramId: number, op: 'add' | 'ded', uid: string, balanceType: WalletBalanceType): Promise<void> {
  const action: WalletAction = op === 'add' ? 'ADD' : 'DEDUCT';
  await sessionStore.set(telegramId, chatId, 'wallet:await_amount', { uid, action, balanceType });
  await telegram.sendMessage({
    chat_id: chatId,
    text: `💰 <b>${action}</b> → ${escapeHtml(balanceType)}\n<code>${escapeHtml(uid)}</code>\n\nSend <b>amount</b> (positive number).\n/cancel to abort.`,
    parse_mode: 'HTML',
  });
}

async function handleWalletAmount(chatId: number, telegramId: number, text: string, ctx: Record<string, unknown>): Promise<void> {
  const amount = Number(text.replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) {
    return void telegram.sendMessage({ chat_id: chatId, text: '❌ Invalid amount. Send a positive number.' });
  }
  await sessionStore.set(telegramId, chatId, 'wallet:await_description', { ...ctx, amount });
  await telegram.sendMessage({
    chat_id: chatId,
    text: '✏️ Send a <b>description</b> for this transaction.\n/cancel to abort.',
    parse_mode: 'HTML',
  });
}

async function handleWalletDescription(chatId: number, telegramId: number, text: string, ctx: Record<string, unknown>): Promise<void> {
  const description = text.trim().slice(0, 200);
  const uid    = String(ctx.uid || '');
  const action = String(ctx.action || 'ADD') as WalletAction;
  const amount = Number(ctx.amount || 0);
  const balanceType = String(ctx.balanceType || 'depositBalance') as WalletBalanceType;

  const idempotencyKey = makeIdempotencyKey(telegramId);
  await sessionStore.set(telegramId, chatId, 'wallet:await_confirm', {
    uid, action, amount, balanceType, description, idempotencyKey,
  });

  const preview = [
    '⚠️ <b>Confirm</b>', '',
    `<b>UID:</b> <code>${escapeHtml(uid)}</code>`,
    `<b>Action:</b> ${action}`,
    `<b>Amount:</b> ₹${toMoney(amount)}`,
    `<b>Balance:</b> ${escapeHtml(balanceType)}`,
    `<b>Note:</b> ${escapeHtml(description)}`,
  ].join('\n');
  await telegram.sendMessage({
    chat_id: chatId, text: preview,
    reply_markup: kb.build([[kb.button('✅ Confirm', CB.walletConfirm), kb.button('❌ Cancel', CB.cancel)]]),
  });
}

async function executeWalletConfirmed(chatId: number, telegramId: number, msgId?: number): Promise<void> {
  const s = await sessionStore.get(telegramId);
  if (!s || s.state !== 'wallet:await_confirm') {
    return sendOrEdit(chatId, '❌ Session expired.', kb.build([backHomeRow(CB.home)]), msgId);
  }
  const c = s.context;
  const action = String(c.action) as WalletAction;
  const type: WalletTxType = action === 'ADD' ? 'ADD_MONEY' : 'ADMIN_DEDUCTION';

  const result = await walletService.execute({
    uid: String(c.uid),
    action,
    type,
    amount: Number(c.amount),
    balanceType: String(c.balanceType) as WalletBalanceType,
    description: String(c.description || ''),
    idempotencyKey: String(c.idempotencyKey),
    performedBy: String(telegramId),
  });

  await sessionStore.clear(telegramId);
  if (!result.ok) {
    await adminLogs.record({
      telegramId, module: 'wallet', action: action.toLowerCase(),
      target: String(c.uid), amount: Number(c.amount),
      result: 'failure', errorMessage: result.message,
    });
    return sendOrEdit(chatId, `❌ Wallet failed: ${escapeHtml(result.message)}`,
      kb.build([backHomeRow(CB.wallet)]), msgId);
  }
  await adminLogs.record({
    telegramId, module: 'wallet', action: action.toLowerCase(),
    target: String(c.uid), amount: Number(c.amount),
    description: String(c.description), result: 'success',
    metadata: { txId: result.txId, balanceType: c.balanceType, duplicate: result.duplicate },
  });

  const text = [
    result.duplicate ? '♻️ <b>Duplicate — already executed.</b>' : '✅ <b>Wallet updated.</b>',
    '',
    renderWalletCard(String(c.uid), result.wallet),
    '',
    `<b>Tx:</b> <code>${escapeHtml(result.txId)}</code>`,
  ].join('\n');
  await sendOrEdit(chatId, text, kb.build([backHomeRow(CB.wallet)]), msgId);
}

// ─── Deposit (add-fund) ─────────────────────────────────────────────────────
async function renderDepositList(chatId: number, msgId: number | undefined, mode: 'pending' | 'history'): Promise<void> {
  const list = mode === 'pending' ? await depositService.pending(10) : await depositService.history(10);
  if (list.length === 0) {
    return sendOrEdit(chatId, `💳 <b>Add-Fund — ${mode}</b>\n\n<i>None.</i>`,
      kb.build([[kb.button('🕓 Pending', CB.depositPending), kb.button('📜 History', CB.depositHistory)], backHomeRow(CB.home)]), msgId);
  }
  const rows = list.map(d => [kb.button(
    `${statusEmoji(d.status)} ₹${toMoney(d.amount)} — ${truncate(d.uid, 10)}`,
    CB.depositView(d.id),
  )]);
  rows.push([kb.button('🕓 Pending', CB.depositPending), kb.button('📜 History', CB.depositHistory)]);
  rows.push(backHomeRow(CB.home));
  await sendOrEdit(chatId, `💳 <b>Add-Fund — ${mode}</b>`, kb.build(rows), msgId);
}

function statusEmoji(s: string): string {
  switch (String(s || '').toUpperCase()) {
    case 'PENDING':   return '🕓';
    case 'APPROVED':
    case 'COMPLETED': return '✅';
    case 'CODE_SENT': return '✉️';
    case 'REJECTED':  return '❌';
    case 'PROCESSING':return '⏳';
    default:          return '•';
  }
}

async function handleDepositAction(chatId: number, telegramId: number, action: string, id: string, msgId?: number, adminName?: string): Promise<void> {
  const dep = await depositService.get(id);
  if (!dep) return sendOrEdit(chatId, '❌ Request not found.', kb.build([backHomeRow(CB.deposit)]), msgId);

  if (action === 'v') {
    const text = [
      '💳 <b>Add-Fund Request</b>', '',
      `<b>ID:</b> <code>${escapeHtml(dep.id)}</code>`,
      `<b>User:</b> ${escapeHtml(dep.userName || '—')}`,
      `<b>Email:</b> ${escapeHtml(dep.userEmail || '—')}`,
      `<b>UID:</b> <code>${escapeHtml(dep.uid)}</code>`,
      `<b>Amount:</b> ₹${toMoney(dep.amount)}`,
      dep.utrNumber ? `<b>UTR:</b> <code>${escapeHtml(dep.utrNumber)}</code>` : '',
      `<b>Status:</b> ${escapeHtml(dep.status)}`,
      dep.screenshotUrl ? `<b>Screenshot:</b> ${escapeHtml(dep.screenshotUrl)}` : '',
      dep.adminNote ? `<b>Admin Note:</b> ${escapeHtml(dep.adminNote)}` : '',
      dep.redeemCode ? `<b>Code:</b> <code>${escapeHtml(dep.redeemCode)}</code>` : '',
    ].filter(Boolean).join('\n');
    const rows: InlineKeyboardButton[][] = [];
    if (dep.status === 'PENDING') {
      rows.push([kb.button('✅ Approve', CB.depositApproveMenu(dep.id)), kb.button('❌ Reject', CB.depositRejectAsk(dep.id))]);
    }
    if (dep.screenshotUrl) rows.push([kb.url('🖼 View Screenshot', dep.screenshotUrl)]);
    rows.push(backHomeRow(CB.deposit));
    return sendOrEdit(chatId, text, kb.build(rows), msgId);
  }

  if (action === 'am') { // approve menu → pick method
    return sendOrEdit(chatId,
      `✅ Approve add-fund <code>${escapeHtml(dep.id)}</code> ₹${toMoney(dep.amount)} — how?`,
      kb.build([
        [kb.button('💰 Credit Directly', CB.depositApproveDirect(dep.id))],
        [kb.button('🎁 Redeem Code + Email', CB.depositApproveCode(dep.id))],
        [kb.button('❌ Cancel', CB.depositView(dep.id))],
      ]), msgId);
  }

  if (action === 'ad') {
    const r = await depositService.approveDirect(dep.id, telegramId);
    return sendOrEdit(chatId, r.ok ? `✅ Credited ₹${toMoney(dep.amount)} to deposit balance.` : `❌ ${escapeHtml(r.error)}`,
      kb.build([backHomeRow(CB.deposit)]), msgId);
  }

  if (action === 'ac') {
    const r = await depositService.approveWithRedeemCode(dep.id, telegramId, {
      sendEmail: true,               // sendEmail now auto-fetches from users/{uid}
      expiresInDays: 7,
      adminName: adminName || `Admin${telegramId}`,
    });
    if (!r.ok) return sendOrEdit(chatId, `❌ ${escapeHtml(r.error)}`, kb.build([backHomeRow(CB.deposit)]), msgId);
    const text = [
      '🎁 <b>Redeem code generated</b>', '',
      `<b>Code:</b> <code>${escapeHtml(r.code)}</code>`,
      `<b>Amount:</b> ₹${toMoney(dep.amount)}`,
      `<b>Assigned by:</b> ${escapeHtml(adminName || `Admin${telegramId}`)}`,
      `<b>Email:</b> ${r.emailed ? '✅ sent to user' : '⚠️ send failed (check EmailJS logs / user profile)'}`,
    ].join('\n');
    return sendOrEdit(chatId, text, kb.build([
      [kb.button('✉️ Resend Email', CB.redeemEmail(r.code))],
      [kb.button('👁 View Code', CB.redeemView(r.code))],
      backHomeRow(CB.deposit),
    ]), msgId);
  }

  if (action === 'ra') {
    await sessionStore.set(telegramId, chatId, 'deposit:await_reject_reason', { depositId: dep.id });
    return void telegram.sendMessage({
      chat_id: chatId,
      text: `❌ Send rejection reason for <code>${escapeHtml(dep.id)}</code>.\n/cancel to abort.`,
      parse_mode: 'HTML',
    });
  }
}

async function handleDepositRejectReason(chatId: number, telegramId: number, text: string, ctx: Record<string, unknown>): Promise<void> {
  const id = String(ctx.depositId || '');
  await sessionStore.clear(telegramId);
  const r = await depositService.reject(id, telegramId, text.trim().slice(0, 500));
  await telegram.sendMessage({
    chat_id: chatId, text: r.ok ? '❌ Rejected.' : `⚠️ ${r.error}`,
    reply_markup: kb.build([backHomeRow(CB.deposit)]),
  });
}

// ─── Withdraw ───────────────────────────────────────────────────────────────
async function renderWithdrawList(chatId: number, msgId: number | undefined, mode: 'pending' | 'history'): Promise<void> {
  const list = mode === 'pending' ? await withdrawService.pending(10) : await withdrawService.history(10);
  if (list.length === 0) {
    return sendOrEdit(chatId, `🏦 <b>Withdrawals — ${mode}</b>\n\n<i>None.</i>`,
      kb.build([[kb.button('🕓 Pending', CB.withdrawPending), kb.button('📜 History', CB.withdrawHistory)], backHomeRow(CB.home)]), msgId);
  }
  const rows = list.map(w => [kb.button(
    `${statusEmoji(w.status)} ₹${toMoney(w.amount)} — ${truncate(w.uid, 10)}`,
    CB.withdrawView(w.id),
  )]);
  rows.push([kb.button('🕓 Pending', CB.withdrawPending), kb.button('📜 History', CB.withdrawHistory)]);
  rows.push(backHomeRow(CB.home));
  await sendOrEdit(chatId, `🏦 <b>Withdrawals — ${mode}</b>`, kb.build(rows), msgId);
}

async function handleWithdrawAction(chatId: number, telegramId: number, action: string, id: string, msgId?: number): Promise<void> {
  const w = await withdrawService.get(id);
  if (!w) return sendOrEdit(chatId, '❌ Not found.', kb.build([backHomeRow(CB.withdraw)]), msgId);

  if (action === 'v') {
    const text = [
      '🏦 <b>Withdrawal</b>', '',
      `<b>ID:</b> <code>${escapeHtml(w.id)}</code>`,
      `<b>UID:</b> <code>${escapeHtml(w.uid)}</code>`,
      `<b>User:</b> ${escapeHtml(w.userName || '—')}`,
      `<b>Email:</b> ${escapeHtml(w.userEmail || '—')}`,
      `<b>Amount:</b> ₹${toMoney(w.amount)}`,
      `<b>Balance:</b> ${escapeHtml(w.balanceType || 'winningBalance')}`,
      `<b>UPI ID:</b> <code>${escapeHtml(w.upiId || '—')}</code>`,
      `<b>Status:</b> ${escapeHtml(w.status)}`,
      w.rejectReason ? `<b>Reject Reason:</b> ${escapeHtml(w.rejectReason)}` : '',
    ].filter(Boolean).join('\n');
    const rows: InlineKeyboardButton[][] = [];
    if (w.status === 'PENDING') {
      rows.push([kb.button('✅ Approve', CB.withdrawApprove(w.id)), kb.button('❌ Reject', CB.withdrawRejectAsk(w.id))]);
    }
    rows.push(backHomeRow(CB.withdraw));
    return sendOrEdit(chatId, text, kb.build(rows), msgId);
  }

  if (action === 'a') {
    return sendOrEdit(chatId,
      `⚠️ Confirm <b>APPROVE</b> ₹${toMoney(w.amount)} → UPI <code>${escapeHtml(w.upiId || '—')}</code>?\nUser: ${escapeHtml(w.userName || '—')}`,
      kb.build([[kb.button('✅ Confirm', CB.withdrawApproveConfirm(w.id)), kb.button('❌ Cancel', CB.withdrawView(w.id))]]), msgId);
  }
  if (action === 'ac') {
    const r = await withdrawService.approve(w.id, telegramId);
    return sendOrEdit(chatId, r.ok ? '✅ Approved.' : `❌ ${escapeHtml(r.error)}`,
      kb.build([backHomeRow(CB.withdraw)]), msgId);
  }
  if (action === 'ra') {
    await sessionStore.set(telegramId, chatId, 'withdraw:await_reject_reason', { withdrawalId: w.id });
    return void telegram.sendMessage({
      chat_id: chatId,
      text: `❌ Send reject reason for <code>${escapeHtml(w.id)}</code>.\n/cancel to abort.`,
      parse_mode: 'HTML',
    });
  }
}

async function handleWithdrawRejectReason(chatId: number, telegramId: number, text: string, ctx: Record<string, unknown>): Promise<void> {
  const id = String(ctx.withdrawalId || '');
  await sessionStore.clear(telegramId);
  const r = await withdrawService.reject(id, telegramId, text.trim().slice(0, 500));
  await telegram.sendMessage({
    chat_id: chatId, text: r.ok ? '❌ Rejected.' : `⚠️ ${r.error}`,
    reply_markup: kb.build([backHomeRow(CB.withdraw)]),
  });
}

// ─── Games ──────────────────────────────────────────────────────────────────
function isGameKind(v: string): v is GameKind {
  return v === 'poker' || v === 'ludo' || v === 'joker' || v === '9card' || v === 'tambola';
}

async function handleGameCallback(chatId: number, telegramId: number, action: string, args: string[], msgId?: number): Promise<void> {
  const kindStr = args[0] || '';
  if (!isGameKind(kindStr)) return sendOrEdit(chatId, '❓ Unknown game.', kb.build([backHomeRow(CB.games)]), msgId);
  const kind = kindStr;

  if (action === 'pick') {
    return sendOrEdit(chatId, `${GAME_LABELS[kind]}`, kb.build([
      [kb.button('➕ New Table', CB.gameCreate(kind))],
      [kb.button('📜 List Tables', CB.gameList(kind))],
      backHomeRow(CB.games),
    ]), msgId);
  }

  if (action === 'new') {
    await sessionStore.set(telegramId, chatId, 'games:await_create_form', { kind });
    const prompts: Record<GameKind, string> = {
      poker: [
        '➕ <b>Create Poker Table</b>',
        '',
        'Send one line:',
        '<code>name | min=100 | max=1000 | sb=5 | bb=10 | max=6</code>',
        '',
        'Required: <code>name</code>, <code>min</code>, <code>max</code>, <code>sb</code>, <code>bb</code>.',
      ].join('\n'),
      ludo: [
        '➕ <b>Create Ludo Table</b>',
        '',
        'Send one line:',
        '<code>tier=Bronze | entry=50 | max=4</code>',
        '',
        'Tiers common: Bronze / Silver / Gold / Diamond.',
      ].join('\n'),
      joker: [
        '➕ <b>Create Joker Table</b>',
        '',
        'Send one line:',
        '<code>name=Pair Room | entry=100 | max=2</code>',
      ].join('\n'),
      '9card': [
        '➕ <b>Create 9-Card Table</b>',
        '',
        'Send one line:',
        '<code>name=9 Rank Card | boot=25 | min=2 | max=2</code>',
      ].join('\n'),
      tambola: [
        '➕ <b>Create Tambola Table</b>',
        '',
        'Send one line:',
        '<code>name=Housie Room | entry=10 | max=10</code>',
        '',
        'Prizes auto: Early 5 + 3 Lines + Full House (pool ka 90%).',
      ].join('\n'),
    };
    return void telegram.sendMessage({
      chat_id: chatId,
      text: prompts[kind] + '\n\n/cancel to abort.',
      parse_mode: 'HTML',
    });
  }

  if (action === 'ls') {
    const tables = await gameService.listTables(kind, 20);
    if (tables.length === 0) {
      return sendOrEdit(chatId, `${GAME_LABELS[kind]}\n\n<i>No tables.</i>`,
        kb.build([[kb.button('➕ New Table', CB.gameCreate(kind))], backHomeRow(CB.gamePicker(kind))]), msgId);
    }
    const rows = tables.map(t => [kb.button(
      `${t.status === 'playing' ? '🟢' : t.status === 'waiting' ? '🟡' : '⚫'} ${truncate(t.name, 14)} — ${t.playerCount}/${t.maxPlayers} — ₹${toMoney(t.pot)}`,
      CB.gameView(kind, t.id),
    )]);
    rows.push([kb.button('➕ New', CB.gameCreate(kind))]);
    rows.push(backHomeRow(CB.gamePicker(kind)));
    return sendOrEdit(chatId, `${GAME_LABELS[kind]} — <b>Tables</b>`, kb.build(rows), msgId);
  }

  const id = args[1];
  if (!id) return sendOrEdit(chatId, '❓ Missing table id.', kb.build([backHomeRow(CB.gamePicker(kind))]), msgId);

  if (action === 'v') {
    const t = await gameService.getTable(kind, id);
    if (!t) return sendOrEdit(chatId, '❌ Table not found.', kb.build([backHomeRow(CB.gameList(kind))]), msgId);
    const r = t.raw;
    const lines: string[] = [
      `${GAME_LABELS[kind]} <b>Table</b>`, '',
      `<b>Name:</b> ${escapeHtml(t.name)}`,
      `<b>ID:</b> <code>${escapeHtml(t.id)}</code>`,
      `<b>Status:</b> ${escapeHtml(t.status)}`,
      `<b>Players:</b> ${t.playerCount}/${t.maxPlayers}`,
      `<b>Pot:</b> ₹${toMoney(t.pot)}`,
    ];
    if (kind === 'poker') {
      lines.push(`<b>Blinds:</b> ${r.smallBlind}/${r.bigBlind}`);
      lines.push(`<b>Buy-In:</b> ₹${r.minBuyIn}–₹${r.maxBuyIn}`);
      lines.push(`<b>Hand #:</b> ${r.handNumber || 0}`);
    } else if (kind === 'ludo') {
      lines.push(`<b>Tier:</b> ${escapeHtml(String(r.tier || '—'))}`);
      lines.push(`<b>Entry:</b> ₹${r.entryFee || 0}`);
      lines.push(`<b>Round:</b> ${r.round || 0}`);
    } else if (kind === 'joker') {
      lines.push(`<b>Entry:</b> ₹${r.entryFee || 0}`);
      lines.push(`<b>Host:</b> ${escapeHtml(String(r.hostId || '—'))}`);
    } else if (kind === '9card') {
      lines.push(`<b>Boot:</b> ₹${r.bootAmount || 0}`);
      lines.push(`<b>Call:</b> ₹${r.currentCallAmount || 0}`);
      lines.push(`<b>Round:</b> ${r.round || 0}`);
    } else if (kind === 'tambola') {
      lines.push(`<b>Entry:</b> ₹${r.entryFee || 0}`);
      lines.push(`<b>Prize Pool:</b> ₹${r.prizePool || 0}`);
      lines.push(`<b>Round:</b> ${r.round || 0}`);
    }
    const players = gameService.extractPlayers(kind, r);
    if (players.length > 0) {
      lines.push('', '<b>Players:</b>');
      players.forEach(p => lines.push(`  • ${escapeHtml(p.name || p.uid.slice(0, 10))} — ₹${toMoney(p.chips)}`));
    }
    return sendOrEdit(chatId, lines.join('\n'), kb.build([
      [kb.button('👢 Kick', CB.gameKickAsk(kind, t.id)), kb.button('💸 Refund All', CB.gameRefundAsk(kind, t.id))],
      [kb.button('🛑 End Table', CB.gameEndAsk(kind, t.id)), kb.button('🗑 Delete', CB.gameDeleteAsk(kind, t.id))],
      backHomeRow(CB.gameList(kind)),
    ]), msgId);
  }

  if (action === 'ka') {
    await sessionStore.set(telegramId, chatId, 'games:await_kick_uid', { kind, tableId: id });
    return void telegram.sendMessage({
      chat_id: chatId,
      text: `👢 Send UID to kick from <code>${escapeHtml(id)}</code>.\n/cancel to abort.`,
      parse_mode: 'HTML',
    });
  }
  if (action === 'ra') return sendOrEdit(chatId,
    `⚠️ Full refund of table <code>${escapeHtml(id)}</code>?`,
    kb.build([[kb.button('✅ Confirm', CB.gameRefundConfirm(kind, id)), kb.button('❌ Cancel', CB.gameView(kind, id))]]), msgId);
  if (action === 'rc') {
    const r = await gameService.refundTable(kind, id, telegramId);
    return sendOrEdit(chatId, r.ok ? `💸 Refunded ₹${toMoney(r.refunded)}.` : `❌ ${escapeHtml(r.error)}`,
      kb.build([backHomeRow(CB.gameList(kind))]), msgId);
  }
  if (action === 'ea') return sendOrEdit(chatId,
    `⚠️ End table <code>${escapeHtml(id)}</code>?`,
    kb.build([[kb.button('✅ Confirm', CB.gameEndConfirm(kind, id)), kb.button('❌ Cancel', CB.gameView(kind, id))]]), msgId);
  if (action === 'ec') {
    const r = await gameService.endTable(kind, id, telegramId);
    return sendOrEdit(chatId, r.ok ? '🛑 Ended.' : `❌ ${escapeHtml(r.error)}`,
      kb.build([backHomeRow(CB.gameList(kind))]), msgId);
  }
  if (action === 'da') return sendOrEdit(chatId,
    `⚠️ Delete table <code>${escapeHtml(id)}</code>?`,
    kb.build([[kb.button('🗑 Confirm Delete', CB.gameDeleteConfirm(kind, id)), kb.button('❌ Cancel', CB.gameView(kind, id))]]), msgId);
  if (action === 'dc') {
    const r = await gameService.deleteTable(kind, id, telegramId);
    return sendOrEdit(chatId, r.ok ? '🗑 Deleted.' : `❌ ${escapeHtml(r.error)}`,
      kb.build([backHomeRow(CB.gameList(kind))]), msgId);
  }
}

function parseKVLine(text: string): { name: string; params: Record<string, string> } {
  const parts = text.split('|').map(s => s.trim());
  const first = parts[0] || '';
  let name = '';
  const params: Record<string, string> = {};
  // If first part has = sign, treat all as key=value.
  if (first.includes('=')) {
    parts.forEach(p => {
      const [k, ...rest] = p.split('=');
      if (k) params[k.trim().toLowerCase()] = rest.join('=').trim();
    });
    name = params.name || params.tier || '';
  } else {
    name = first;
    parts.slice(1).forEach(p => {
      const [k, ...rest] = p.split('=');
      if (k) params[k.trim().toLowerCase()] = rest.join('=').trim();
    });
  }
  return { name, params };
}

async function handleGameCreateForm(chatId: number, telegramId: number, text: string, ctx: Record<string, unknown>): Promise<void> {
  const kind = String(ctx.kind || 'poker') as GameKind;
  const { name, params } = parseKVLine(text);
  await sessionStore.clear(telegramId);

  const num = (k: string, def = 0) => {
    const v = params[k];
    if (v === undefined || v === '') return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  };

  let result: { ok: true; id: string } | { ok: false; error: string };
  if (kind === 'poker') {
    result = await gameService.createPokerTable({
      name,
      minBuyIn: num('min', 100),
      maxBuyIn: num('max', 1000),
      smallBlind: num('sb', 5),
      bigBlind: num('bb', 10),
      maxPlayers: num('maxplayers', 6),
      adminId: telegramId,
    });
  } else if (kind === 'ludo') {
    result = await gameService.createLudoTable({
      name: name || params.tier || 'Bronze',
      tier: params.tier || name || 'Bronze',
      entryFee: num('entry', 50),
      maxPlayers: num('max', 4),
      adminId: telegramId,
    });
  } else if (kind === 'joker') {
    result = await gameService.createJokerTable({
      name: name || 'Joker Table',
      entryFee: num('entry', 100),
      maxPlayers: num('max', 2),
      hostId: params.host || null,
      adminId: telegramId,
    });
  } else if (kind === 'tambola') {
    result = await gameService.createTambolaTable({
      name: name || 'Housie Room',
      entryFee: num('entry', 10),
      maxPlayers: num('max', 10),
      adminId: telegramId,
    });
  } else {
    result = await gameService.createNineCardTable({
      name: name || '9 Rank Card',
      bootAmount: num('boot', 25),
      minPlayers: num('min', 2),
      maxPlayers: num('max', 2),
      adminId: telegramId,
    });
  }

  await telegram.sendMessage({
    chat_id: chatId,
    text: result.ok
      ? `✅ ${GAME_LABELS[kind]} table created.\n<b>ID:</b> <code>${escapeHtml(result.id)}</code>`
      : `❌ ${result.error}`,
    parse_mode: 'HTML',
    reply_markup: kb.build([
      result.ok ? [kb.button('👁 View', CB.gameView(kind, result.id))] : [],
      [kb.button('📜 List', CB.gameList(kind)), kb.button('➕ New', CB.gameCreate(kind))],
      backHomeRow(CB.gamePicker(kind)),
    ].filter(r => r.length > 0)),
  });
}

async function handleGameKickUid(chatId: number, telegramId: number, uid: string, ctx: Record<string, unknown>): Promise<void> {
  const kind = String(ctx.kind || 'poker') as GameKind;
  const tableId = String(ctx.tableId || '');
  await sessionStore.clear(telegramId);
  const r = await gameService.kickPlayer(kind, tableId, uid.trim(), telegramId);
  await telegram.sendMessage({
    chat_id: chatId,
    text: r.ok ? '👢 Kicked & refunded.' : `❌ ${r.error}`,
    reply_markup: kb.build([backHomeRow(CB.gameView(kind, tableId))]),
  });
}

// ─── Redeem codes ───────────────────────────────────────────────────────────
async function handleRedeemCallback(chatId: number, telegramId: number, action: string, args: string[], msgId?: number): Promise<void> {
  if (action === 'new') {
    await sessionStore.set(telegramId, chatId, 'redeem:await_form');
    return void telegram.sendMessage({
      chat_id: chatId,
      text: [
        '🎁 <b>New Redeem Code</b>',
        '',
        '💡 <b>Tip:</b> Easier way — open a pending deposit request and tap',
        '"🎁 Redeem Code + Email". uid, amount &amp; email auto-fill.',
        '',
        'Or send one line manually:',
        '<code>amount=500 | uid=USERUID | admin=Javed | days=7 | note=birthday</code>',
        '',
        '<b>Required:</b> <code>amount</code>, <code>uid</code>',
        '<b>Optional:</b> <code>admin</code> (goes into asignBy), <code>days</code>, <code>note</code>',
        '',
        'Email is auto-fetched from users/{uid} — no need to type it.',
        '',
        '/cancel to abort.',
      ].join('\n'),
      parse_mode: 'HTML',
    });
  }

  if (action === 'list' || action === 'act') {
    const status = action === 'act' ? 'ACTIVE' as const : undefined;
    const list = await redeemService.list(20, status);
    if (list.length === 0) {
      return sendOrEdit(chatId, `🎁 <b>Codes</b>\n\n<i>None.</i>`,
        kb.build([[kb.button('➕ New', CB.redeemCreate)], backHomeRow(CB.redeem)]), msgId);
    }
    const rows = list.map(c => [kb.button(
      `${c.status === 'ACTIVE' ? '🟢' : c.status === 'USED' ? '✅' : '⚫'} ${c.code} — ₹${toMoney(c.amount)}`,
      CB.redeemView(c.code),
    )]);
    rows.push([kb.button('➕ New', CB.redeemCreate)]);
    rows.push(backHomeRow(CB.redeem));
    return sendOrEdit(chatId, `🎁 <b>Codes — ${action === 'act' ? 'active' : 'all'}</b>`, kb.build(rows), msgId);
  }

  const code = args[0];
  if (!code) return sendOrEdit(chatId, '❓ Missing code.', kb.build([backHomeRow(CB.redeem)]), msgId);

  if (action === 'v') {
    const r = await redeemService.get(code);
    if (!r) return sendOrEdit(chatId, '❌ Not found.', kb.build([backHomeRow(CB.redeem)]), msgId);
    const text = [
      '🎁 <b>Redeem Code</b>', '',
      `<b>Code:</b> <code>${escapeHtml(r.code)}</code>`,
      `<b>Amount:</b> ₹${toMoney(r.amount)}`,
      `<b>Status:</b> ${escapeHtml(r.status)}${r.used ? ' (used)' : ''}`,
      `<b>UID:</b> <code>${escapeHtml(r.uid)}</code>`,
      `<b>Assigned by:</b> ${escapeHtml(r.asignBy)}`,
      r.expiresAt ? `<b>Expires:</b> ${new Date(r.expiresAt).toLocaleString('en-IN')}` : '',
      `<b>Email sent:</b> ${r.emailSent ? '✅' : '—'}`,
      r.usedBy ? `<b>Used by:</b> ${escapeHtml(r.usedByName || r.usedBy)}` : '',
      r.usedAt ? `<b>Used at:</b> ${new Date(r.usedAt).toLocaleString('en-IN')}` : '',
      r.note ? `<b>Note:</b> ${escapeHtml(r.note)}` : '',
    ].filter(Boolean).join('\n');
    const rows: InlineKeyboardButton[][] = [];
    if (r.status === 'ACTIVE') {
      rows.push([kb.button('✉️ Send Email', CB.redeemEmail(r.code))]);
      rows.push([kb.button('💰 Apply Now', CB.redeemApply(r.code))]);
      rows.push([kb.button('🚫 Revoke', CB.redeemRevoke(r.code))]);
    }
    rows.push(backHomeRow(CB.redeem));
    return sendOrEdit(chatId, text, kb.build(rows), msgId);
  }

  if (action === 'em') {
    const r = await redeemService.sendEmail(code, telegramId);
    return sendOrEdit(chatId, r.ok ? '✉️ Email sent.' : `❌ ${escapeHtml(r.error)}`,
      kb.build([backHomeRow(CB.redeemView(code))]), msgId);
  }
  if (action === 'ap') {
    // Admin bypass — apply the code to its assigned user without the
    // client-side "must be the redeeming user" check.
    const r = await redeemService.adminApply(code, telegramId);
    return sendOrEdit(chatId, r.ok ? '💰 Applied.' : `❌ ${escapeHtml(r.error)}`,
      kb.build([backHomeRow(CB.redeem)]), msgId);
  }
  if (action === 'rv') {
    const r = await redeemService.revoke(code, telegramId);
    return sendOrEdit(chatId, r.ok ? '🚫 Revoked.' : `❌ ${escapeHtml(r.error)}`,
      kb.build([backHomeRow(CB.redeem)]), msgId);
  }
}

async function handleRedeemForm(chatId: number, telegramId: number, text: string, ctx: Record<string, unknown>): Promise<void> {
  await sessionStore.clear(telegramId);
  const parts = text.split('|').map(s => s.trim());
  const kv: Record<string, string> = {};
  parts.forEach(p => {
    const [k, ...rest] = p.split('=');
    if (k) kv[k.trim().toLowerCase()] = rest.join('=').trim();
  });
  const amount = Number(kv.amount || 0);
  if (!amount || amount <= 0) {
    return void telegram.sendMessage({ chat_id: chatId, text: '❌ Invalid amount.',
      reply_markup: kb.build([backHomeRow(CB.redeem)]) });
  }
  if (!kv.uid) {
    return void telegram.sendMessage({ chat_id: chatId, text: '❌ uid required. Use the deposit request → "Redeem Code + Email" button instead — it auto-fills uid.',
      reply_markup: kb.build([backHomeRow(CB.redeem)]) });
  }
  // adminName priority: form input → session context (from Telegram msg.from) → fallback string
  const adminName = kv.admin || (typeof ctx.adminName === 'string' ? ctx.adminName : '') || `Admin${telegramId}`;

  const r = await redeemService.create({
    amount,
    uid: kv.uid,
    adminId: telegramId,
    adminName,
    expiresInDays: kv.days ? Number(kv.days) : 7,
    note: kv.note,
  });
  if (!r.ok) {
    return void telegram.sendMessage({ chat_id: chatId, text: `❌ ${r.error}`,
      reply_markup: kb.build([backHomeRow(CB.redeem)]) });
  }
  // Always try to email — sendEmail fetches the user's email from users/{uid}
  const em = await redeemService.sendEmail(r.code.code, telegramId);
  const emailed = em.ok;

  await telegram.sendMessage({
    chat_id: chatId,
    text: [
      '🎁 <b>Code Created</b>', '',
      `<b>Code:</b> <code>${escapeHtml(r.code.code)}</code>`,
      `<b>Amount:</b> ₹${toMoney(amount)}`,
      `<b>Assigned by:</b> ${escapeHtml(adminName)}`,
      `<b>Email:</b> ${emailed ? '✅ sent' : `⚠️ ${em.ok ? '' : em.error}`}`,
    ].filter(Boolean).join('\n'),
    parse_mode: 'HTML',
    reply_markup: kb.build([
      [kb.button('👁 View', CB.redeemView(r.code.code))],
      backHomeRow(CB.redeem),
    ]),
  });
}

// ─── Reports ────────────────────────────────────────────────────────────────
async function handleReport(chatId: number, msgId: number | undefined, action: string): Promise<void> {
  let text = '';
  try {
    switch (action) {
      case 'users': {
        const r = await reportsService.users('30d');
        text = ['👥 <b>Users — 30d</b>', '',
          `Total:  ${r.total}`, `Active: ${r.active}`, `Banned: ${r.banned}`, `New:    ${r.newInRange}`].join('\n');
        break;
      }
      case 'revenue': {
        const r = await reportsService.revenue('30d');
        text = ['💵 <b>Revenue — 30d</b>', '',
          `Deposits:    ₹${toMoney(r.totalDeposits)} (${r.count.deposits})`,
          `Withdrawals: ₹${toMoney(r.totalWithdrawals)} (${r.count.withdrawals})`,
          `Net:         ₹${toMoney(r.net)}`].join('\n');
        break;
      }
      case 'deposit': {
        const r = await reportsService.deposits('30d');
        text = ['💳 <b>Add-Fund — 30d</b>', '',
          `Pending:  ${r.pending}`, `Approved: ${r.approvedInRange}`, `Total:    ${r.totalInRange}`].join('\n');
        break;
      }
      case 'withdraw': {
        const r = await reportsService.withdrawals('30d');
        text = ['🏦 <b>Withdrawals — 30d</b>', '',
          `Pending:  ${r.pending}`, `Approved: ${r.approvedInRange}`, `Total:    ${r.totalInRange}`].join('\n');
        break;
      }
      case 'wallet': {
        const r = await reportsService.wallets();
        text = ['💰 <b>Wallets (≤1000 sample)</b>', '',
          `Wallets: ${r.totalWallets}`,
          `Total balance: ₹${toMoney(r.totalBalance)}`,
          `Avg balance:   ₹${toMoney(r.avgBalance)}`].join('\n');
        break;
      }
      case 'games': {
        const r = await reportsService.games();
        text = ['🎮 <b>Games</b>', '',
          `Poker:    total ${r.poker.total}, running ${r.poker.running}`,
          `Ludo:     total ${r.ludo.total}, running ${r.ludo.running}`,
          `Joker:    total ${r.joker.total}, running ${r.joker.running}`,
          `9-Card:   total ${r.ninecard.total}, running ${r.ninecard.running}`,
          `Tambola:  total ${r.tambola.total}, running ${r.tambola.running}`].join('\n');
        break;
      }
      default: text = '❓ Unknown report';
    }
  } catch (err) {
    text = `❌ Report failed: ${escapeHtml((err as Error).message)}`;
  }
  await sendOrEdit(chatId, text, kb.build([backHomeRow(CB.reports)]), msgId);
}

// ─── Broadcast ──────────────────────────────────────────────────────────────
async function handleBroadcastMenu(chatId: number, telegramId: number, action: string, msgId?: number): Promise<void> {
  const typeMap: Record<string, BroadcastMediaType> = { text: 'text', image: 'image', video: 'video', pdf: 'pdf' };
  if (action === 'confirm') {
    const s = await sessionStore.get(telegramId);
    if (!s || !s.context.broadcast)
      return sendOrEdit(chatId, '❌ Nothing to broadcast.', kb.build([backHomeRow(CB.broadcast)]), msgId);
    const input = s.context.broadcast as BroadcastInput;
    await sessionStore.clear(telegramId);
    await sendOrEdit(chatId, '📢 Broadcasting…', kb.build([backHomeRow(CB.broadcast)]), msgId);
    const r = await broadcastService.send(input, telegramId);
    return void telegram.sendMessage({
      chat_id: chatId,
      text: `📢 Attempted: ${r.attempted}\nSucceeded: ${r.succeeded}\nFailed: ${r.failed}`,
      reply_markup: kb.build([backHomeRow(CB.broadcast)]),
    });
  }
  const type = typeMap[action];
  if (!type) return sendOrEdit(chatId, '❓ Unknown type.', kb.build([backHomeRow(CB.broadcast)]), msgId);
  await sessionStore.set(telegramId, chatId, 'broadcast:await_content', { type });
  const prompt = type === 'text'
    ? '📝 Send the broadcast <b>text</b>.'
    : `📎 Send the ${type.toUpperCase()} as URL or file_id, optional caption on the next line.`;
  await telegram.sendMessage({ chat_id: chatId, text: `${prompt}\n/cancel to abort.`, parse_mode: 'HTML' });
}

async function handleBroadcastContent(chatId: number, telegramId: number, msg: TelegramMessage, ctx: Record<string, unknown>): Promise<void> {
  const type = String(ctx.type || 'text') as BroadcastMediaType;
  let content = ''; let caption: string | undefined;
  if (type === 'text') {
    content = (msg.text || '').trim();
  } else if (msg.photo && msg.photo.length > 0) {
    content = msg.photo[msg.photo.length - 1]!.file_id; caption = msg.caption;
  } else if (msg.document) {
    content = msg.document.file_id; caption = msg.caption;
  } else if (msg.text) {
    const parts = msg.text.split('\n');
    content = (parts[0] || '').trim();
    caption = parts.slice(1).join('\n').trim() || undefined;
  }
  if (!content) return void telegram.sendMessage({ chat_id: chatId, text: '❌ Empty — try again.' });

  const input: BroadcastInput = { type, content, caption };
  await sessionStore.set(telegramId, chatId, 'broadcast:await_confirm', { broadcast: input });

  const preview = [
    '📢 <b>Confirm Broadcast</b>', '',
    `Type: <code>${type}</code>`,
    `Content: <code>${escapeHtml(truncate(content, 100))}</code>`,
    caption ? `Caption: ${escapeHtml(truncate(caption, 100))}` : '',
  ].filter(Boolean).join('\n');
  await telegram.sendMessage({
    chat_id: chatId, text: preview,
    reply_markup: kb.build([[kb.button('✅ Send Now', CB.broadcastConfirm), kb.button('❌ Cancel', CB.cancel)]]),
  });
}

// ─── AI ─────────────────────────────────────────────────────────────────────
async function handleAiMenu(chatId: number, telegramId: number, action: string, msgId?: number): Promise<void> {
  const modeMap: Record<string, 'chat' | 'code' | 'logs' | 'debug'> = { chat: 'chat', code: 'code', logs: 'logs', debug: 'debug' };
  const mode = modeMap[action];
  if (!mode) return;
  // Fresh session — empty history, seeds the conversation
  await sessionStore.set(telegramId, chatId, 'ai:await_prompt', { mode, history: [] });
  await telegram.sendMessage({
    chat_id: chatId,
    text: [
      `🤖 <b>${mode.toUpperCase()}</b> chat started`,
      '',
      'Send your question. I remember context, so ask follow-ups naturally.',
      '',
      'Tap <b>🔚 End Chat</b> when done, or /cancel to abort.',
    ].join('\n'),
    parse_mode: 'HTML',
    reply_markup: kb.build([[kb.button('🔚 End Chat', CB.aiEndChat)], backHomeRow(CB.ai)]),
  });
}

async function handleAiPrompt(chatId: number, telegramId: number, text: string, ctx: Record<string, unknown>): Promise<void> {
  const mode = String(ctx.mode || 'chat') as 'chat' | 'code' | 'logs' | 'debug';
  // Previous conversation turns — router keeps them in session context.
  const rawHistory = Array.isArray(ctx.history) ? ctx.history : [];
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = rawHistory.filter(
    (m): m is { role: 'user' | 'assistant'; content: string } =>
      !!m && typeof m === 'object' &&
      (m.role === 'user' || m.role === 'assistant') &&
      typeof m.content === 'string',
  );

  await telegram.sendMessage({ chat_id: chatId, text: '🤖 Thinking…' });

  const r = await aiService.ask(mode, text, telegramId, history);
  const reply = r.ok ? r.reply : `❌ ${r.error}`;

  // Append this exchange and cap history at 10 turns (20 messages)
  const nextHistory = [
    ...history,
    { role: 'user' as const, content: text },
    ...(r.ok ? [{ role: 'assistant' as const, content: r.reply }] : []),
  ].slice(-20);

  // KEEP the session alive so the next message continues the conversation
  await sessionStore.set(telegramId, chatId, 'ai:await_prompt', { mode, history: nextHistory });

  await telegram.sendMessage({
    chat_id: chatId,
    text: [
      `<b>AI (${mode})</b>`,
      '',
      escapeHtml(truncate(reply, 3500)),
      '',
      `<i>💬 Continue chatting — ${Math.floor(nextHistory.length / 2)} turn(s). Tap End Chat to finish.</i>`,
    ].join('\n'),
    parse_mode: 'HTML',
    reply_markup: kb.build([
      [kb.button('🔚 End Chat', CB.aiEndChat)],
      backHomeRow(CB.ai),
    ]),
  });
}

async function handleAiEndChat(chatId: number, telegramId: number, msgId?: number): Promise<void> {
  await sessionStore.clear(telegramId);
  await sendOrEdit(
    chatId,
    '✅ Chat ended.\n\nStart a new one from the AI menu.',
    kb.build([backHomeRow(CB.ai)]),
    msgId,
  );
}

// ─── AI Agent (natural language → tool calls) ───────────────────────────────
function agentReplyKeyboard() {
  return kb.build([
    [kb.button('🔚 End Chat', CB.aiEndChat)],
    backHomeRow(CB.ai),
  ]);
}
function agentConfirmKeyboard() {
  return kb.build([
    [kb.button('✅ Confirm', CB.aiAgentConfirm), kb.button('❌ Cancel', CB.aiAgentCancel)],
    [kb.button('✏️ Modify', CB.aiAgentModify)],
    [kb.button('🔚 End Chat', CB.aiEndChat)],
  ]);
}

async function handleAiAgentStart(chatId: number, telegramId: number, msgId?: number): Promise<void> {
  await sessionStore.set(telegramId, chatId, 'ai:await_agent_prompt', { history: [] });
  await sendOrEdit(
    chatId,
    [
      '🪄 <b>Agent mode started</b>',
      '',
      'Bolke kaam karwao — jaise:',
      '• "rahul@x.com ke liye 500 ka redeem code banao"',
      '• "pending withdrawals dikhao"',
      '• "is user ko ban karo — fraud"',
      '',
      'Destructive actions ke liye main confirm button dikhaunga.',
      'Tap <b>🔚 End Chat</b> jab done ho.',
    ].join('\n'),
    kb.build([[kb.button('🔚 End Chat', CB.aiEndChat)], backHomeRow(CB.ai)]),
    msgId,
  );
}

async function handleAiAgentPrompt(chatId: number, telegramId: number, text: string, ctx: Record<string, unknown>): Promise<void> {
  const rawHistory = Array.isArray(ctx.history) ? (ctx.history as AgentTurn[]) : [];

  await telegram.sendMessage({ chat_id: chatId, text: '🪄 Thinking…' });

  const r = await askAgent(rawHistory, text, telegramId);

  if (r.kind === 'error') {
    await sessionStore.set(telegramId, chatId, 'ai:await_agent_prompt', { history: rawHistory });
    await telegram.sendMessage({
      chat_id: chatId,
      text: `❌ ${escapeHtml(r.error)}`,
      reply_markup: agentReplyKeyboard(),
    });
    return;
  }

  if (r.kind === 'text') {
    // Cap history at 20 turns
    const nextHistory = r.history.slice(-20);
    await sessionStore.set(telegramId, chatId, 'ai:await_agent_prompt', { history: nextHistory });
    await telegram.sendMessage({
      chat_id: chatId,
      text: [
        '🪄 <b>Agent</b>',
        '',
        escapeHtml(truncate(r.reply, 3500)),
      ].join('\n'),
      reply_markup: agentReplyKeyboard(),
    });
    return;
  }

  // writeTool — needs user confirmation
  const nextHistory = r.history.slice(-20);
  await sessionStore.set(telegramId, chatId, 'ai:await_agent_prompt', {
    history: nextHistory,
    pending: { name: r.name, args: r.args, toolCallId: r.toolCallId },
  });
  await telegram.sendMessage({
    chat_id: chatId,
    text: [
      '⚠️ <b>Confirm action</b>',
      '',
      r.preview,
    ].join('\n'),
    reply_markup: agentConfirmKeyboard(),
  });
}

async function handleAiAgentCancel(chatId: number, telegramId: number, msgId?: number): Promise<void> {
  const s = await sessionStore.get(telegramId);
  const history = (s?.context.history as AgentTurn[] | undefined) || [];
  // Drop pending; keep history
  await sessionStore.set(telegramId, chatId, 'ai:await_agent_prompt', { history });
  await sendOrEdit(chatId, '❌ Action cancelled. Aur kya karna hai?', agentReplyKeyboard(), msgId);
}

async function handleAiAgentModify(chatId: number, telegramId: number, msgId?: number): Promise<void> {
  const s = await sessionStore.get(telegramId);
  const history = (s?.context.history as AgentTurn[] | undefined) || [];
  await sessionStore.set(telegramId, chatId, 'ai:await_agent_prompt', { history });
  await sendOrEdit(chatId, '✏️ Batao kya change karna hai — main dobara propose karunga.', agentReplyKeyboard(), msgId);
}

async function handleAiAgentConfirm(chatId: number, telegramId: number, adminName: string, msgId?: number): Promise<void> {
  const s = await sessionStore.get(telegramId);
  if (!s || s.state !== 'ai:await_agent_prompt') {
    return sendOrEdit(chatId, '❌ Session expired.', kb.build([backHomeRow(CB.ai)]), msgId);
  }
  const pending = s.context.pending as { name: WriteToolName; args: Record<string, unknown>; toolCallId?: string } | undefined;
  if (!pending) {
    return sendOrEdit(chatId, '❌ Kuch confirm karne ko nahi hai.', agentReplyKeyboard(), msgId);
  }

  const history = (s.context.history as AgentTurn[] | undefined) || [];
  // Clear pending IMMEDIATELY so a double-tap can't re-execute.
  await sessionStore.set(telegramId, chatId, 'ai:await_agent_prompt', { history });

  await telegram.sendMessage({ chat_id: chatId, text: '⏳ Executing…' });
  const outcome = await executeWriteTool(pending.name, pending.args, telegramId, adminName);

  const resultText = outcome.ok
    ? `✅ <b>Done</b>\n\n${outcome.summary}`
    : `❌ <b>Failed</b>\n\n${escapeHtml(outcome.error)}`;

  await telegram.sendMessage({
    chat_id: chatId,
    text: resultText,
    reply_markup: agentReplyKeyboard(),
  });
}

type WriteOutcome = { ok: true; summary: string } | { ok: false; error: string };

/**
 * Server-side dispatcher for confirmed write actions. Re-validates args
 * (defense in depth against LLM hallucination) before hitting services.
 */
async function executeWriteTool(
  name: WriteToolName,
  args: Record<string, unknown>,
  adminId: number,
  adminName: string,
): Promise<WriteOutcome> {
  const str = (k: string) => String(args[k] ?? '').trim();
  const num = (k: string) => {
    const n = Number(args[k]);
    return Number.isFinite(n) ? n : NaN;
  };

  try {
    switch (name) {
      case 'create_redeem_code': {
        const uid = str('uid'), amount = num('amount');
        if (!uid) return { ok: false, error: 'uid required' };
        if (!(amount > 0)) return { ok: false, error: 'amount must be positive' };
        const days = Number(args.expires_in_days ?? 7);
        const send = args.send_email !== false;
        const r = await redeemService.create({
          uid, amount, adminId, adminName,
          expiresInDays: Number.isFinite(days) && days > 0 ? days : 7,
          note: args.note ? String(args.note) : undefined,
        });
        if (!r.ok) return { ok: false, error: r.error };
        let emailed = false, emailErr = '';
        if (send) {
          const em = await redeemService.sendEmail(r.code.code, adminId);
          emailed = em.ok;
          if (!em.ok) emailErr = em.error;
        }
        return { ok: true, summary: [
          `Code: <code>${escapeHtml(r.code.code)}</code>`,
          `Amount: ₹${toMoney(amount)}`,
          `UID: <code>${escapeHtml(uid)}</code>`,
          `Assigned by: ${escapeHtml(adminName)}`,
          `Email: ${send ? (emailed ? '✅ sent' : `⚠️ ${escapeHtml(emailErr)}`) : '—'}`,
        ].join('\n') };
      }
      case 'send_redeem_email': {
        const code = str('code');
        if (!code) return { ok: false, error: 'code required' };
        const r = await redeemService.sendEmail(code, adminId);
        return r.ok ? { ok: true, summary: `✉️ Email sent for code <code>${escapeHtml(code)}</code>.` }
                    : { ok: false, error: r.error };
      }
      case 'revoke_redeem_code': {
        const code = str('code');
        if (!code) return { ok: false, error: 'code required' };
        const r = await redeemService.revoke(code, adminId);
        return r.ok ? { ok: true, summary: `🚫 Revoked <code>${escapeHtml(code)}</code>.` }
                    : { ok: false, error: r.error };
      }
      case 'approve_withdrawal': {
        const id = str('id');
        if (!id) return { ok: false, error: 'id required' };
        const r = await withdrawService.approve(id, adminId);
        return r.ok ? { ok: true, summary: `Withdrawal <code>${escapeHtml(id)}</code> approved.` }
                    : { ok: false, error: r.error };
      }
      case 'reject_withdrawal': {
        const id = str('id'), reason = str('reason');
        if (!id) return { ok: false, error: 'id required' };
        if (!reason) return { ok: false, error: 'reason required' };
        const r = await withdrawService.reject(id, adminId, reason.slice(0, 500));
        return r.ok ? { ok: true, summary: `Withdrawal <code>${escapeHtml(id)}</code> rejected.` }
                    : { ok: false, error: r.error };
      }
      case 'approve_deposit_direct': {
        const id = str('id');
        if (!id) return { ok: false, error: 'id required' };
        const r = await depositService.approveDirect(id, adminId);
        return r.ok ? { ok: true, summary: `Deposit <code>${escapeHtml(id)}</code> credited. Tx: <code>${escapeHtml(r.txId)}</code>` }
                    : { ok: false, error: r.error };
      }
      case 'approve_deposit_with_code': {
        const id = str('id');
        if (!id) return { ok: false, error: 'id required' };
        const days = Number(args.expires_in_days ?? 7);
        const send = args.send_email !== false;
        const r = await depositService.approveWithRedeemCode(id, adminId, {
          sendEmail: send,
          expiresInDays: Number.isFinite(days) && days > 0 ? days : 7,
          adminName,
        });
        return r.ok ? { ok: true, summary: [
          `Deposit <code>${escapeHtml(id)}</code> → Code: <code>${escapeHtml(r.code)}</code>`,
          `Email: ${r.emailed ? '✅ sent' : '⚠️ not sent'}`,
        ].join('\n') } : { ok: false, error: r.error };
      }
      case 'reject_deposit': {
        const id = str('id'), reason = str('reason');
        if (!id) return { ok: false, error: 'id required' };
        if (!reason) return { ok: false, error: 'reason required' };
        const r = await depositService.reject(id, adminId, reason.slice(0, 500));
        return r.ok ? { ok: true, summary: `Deposit <code>${escapeHtml(id)}</code> rejected.` }
                    : { ok: false, error: r.error };
      }
      case 'ban_user': {
        const uid = str('uid'), reason = str('reason');
        if (!uid) return { ok: false, error: 'uid required' };
        if (!reason) return { ok: false, error: 'reason required' };
        await usersService.ban(uid, reason.slice(0, 300), adminId);
        await adminLogs.record({ telegramId: adminId, module: 'users', action: 'ban', target: uid, result: 'success', description: reason });
        return { ok: true, summary: `🚫 Banned <code>${escapeHtml(uid)}</code>.` };
      }
      case 'unban_user': {
        const uid = str('uid');
        if (!uid) return { ok: false, error: 'uid required' };
        await usersService.unban(uid, adminId);
        await adminLogs.record({ telegramId: adminId, module: 'users', action: 'unban', target: uid, result: 'success' });
        return { ok: true, summary: `✅ Unbanned <code>${escapeHtml(uid)}</code>.` };
      }
      case 'delete_user': {
        const uid = str('uid');
        if (!uid) return { ok: false, error: 'uid required' };
        const r = await usersService.remove(uid, adminId);
        await adminLogs.record({ telegramId: adminId, module: 'users', action: 'delete', target: uid, result: r.ok ? 'success' : 'failure' });
        return r.ok ? { ok: true, summary: `🗑 Deleted <code>${escapeHtml(uid)}</code>.` }
                    : { ok: false, error: r.error };
      }
      case 'add_wallet_money':
      case 'deduct_wallet_money': {
        const uid = str('uid'), amount = num('amount');
        const balanceType = str('balance_type') as WalletBalanceType;
        if (!uid) return { ok: false, error: 'uid required' };
        if (!(amount > 0)) return { ok: false, error: 'amount must be positive' };
        if (!['depositBalance','winningBalance','bonusBalance','referralBalance'].includes(balanceType))
          return { ok: false, error: 'balance_type invalid' };

        const action: WalletAction = name === 'add_wallet_money' ? 'ADD' : 'DEDUCT';
        const type: WalletTxType   = action === 'ADD' ? 'ADD_MONEY' : 'ADMIN_DEDUCTION';

        const r = await walletService.execute({
          uid, action, type, amount, balanceType,
          description: (str('description') || `${action} via AI agent`).slice(0, 200),
          idempotencyKey: makeIdempotencyKey(adminId),
          performedBy: String(adminId),
        });
        if (!r.ok) return { ok: false, error: r.message };
        return { ok: true, summary: [
          `${action} ₹${toMoney(amount)} → ${escapeHtml(balanceType)}`,
          `UID: <code>${escapeHtml(uid)}</code>`,
          renderWalletCard(uid, r.wallet),
          `Tx: <code>${escapeHtml(r.txId)}</code>`,
        ].join('\n') };
      }
      case 'update_transaction': {
        const id = str('id');
        if (!id) return { ok: false, error: 'id required' };
        const patch: { status?: string; description?: string; note?: string } = {};
        if (args.status      !== undefined) patch.status      = String(args.status).slice(0, 50);
        if (args.description !== undefined) patch.description = String(args.description).slice(0, 200);
        if (args.note        !== undefined) patch.note        = String(args.note).slice(0, 500);
        if (Object.keys(patch).length === 0) return { ok: false, error: 'nothing to update' };
        const r = await walletService.updateTransaction(id, patch, adminId);
        if (!r.ok) return { ok: false, error: r.error };
        await adminLogs.record({
          telegramId: adminId, module: 'wallet', action: 'tx_update',
          target: id, result: 'success', metadata: patch as Record<string, unknown>,
        });
        return { ok: true, summary: `Transaction <code>${escapeHtml(id)}</code> updated (${Object.keys(patch).join(', ')}).` };
      }
      case 'adjust_transaction': {
        const orig = str('original_tx_id');
        const delta = num('delta');
        const balanceType = str('balance_type') as WalletBalanceType;
        const reason = str('reason');
        if (!orig) return { ok: false, error: 'original_tx_id required' };
        if (!Number.isFinite(delta) || delta === 0) return { ok: false, error: 'delta must be non-zero' };
        if (!['depositBalance','winningBalance','bonusBalance','referralBalance'].includes(balanceType))
          return { ok: false, error: 'balance_type invalid' };
        if (!reason) return { ok: false, error: 'reason required' };
        const r = await walletService.adjustTransaction(orig, delta, balanceType, adminId, reason.slice(0, 300));
        if (!r.ok) return { ok: false, error: r.error };
        await adminLogs.record({
          telegramId: adminId, module: 'wallet', action: 'tx_adjust',
          target: orig, amount: Math.abs(delta), result: 'success',
          metadata: { delta, balanceType, newTxId: r.newTxId, reason },
        });
        return { ok: true, summary: [
          `${delta >= 0 ? '➕ Credit' : '➖ Debit'} ₹${toMoney(Math.abs(delta))} on ${escapeHtml(balanceType)}`,
          `Original: <code>${escapeHtml(orig)}</code>`,
          `New tx: <code>${escapeHtml(r.newTxId || '')}</code>`,
        ].join('\n') };
      }
      case 'send_broadcast': {
        const rawType = str('type') || 'text';
        const type = (['text','image','video','pdf'] as BroadcastMediaType[]).includes(rawType as BroadcastMediaType)
          ? rawType as BroadcastMediaType : 'text';
        const content = String(args.content ?? '').trim();
        if (!content) return { ok: false, error: 'content required' };
        const input: BroadcastInput = { type, content, caption: args.caption ? String(args.caption) : undefined };
        const r = await broadcastService.send(input, adminId);
        return { ok: true, summary: `📢 Attempted: ${r.attempted}, ok: ${r.succeeded}, failed: ${r.failed}` };
      }
      default:
        return { ok: false, error: `unknown write tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── Logs ───────────────────────────────────────────────────────────────────
async function renderLogs(chatId: number, msgId: number | undefined, mode: 'recent' | 'mine', telegramId?: number): Promise<void> {
  const list = mode === 'recent' ? await adminLogs.recent(20) : await adminLogs.byAdmin(telegramId!, 20);
  if (list.length === 0) {
    return sendOrEdit(chatId, '📋 <b>Logs</b>\n\n<i>None.</i>',
      kb.build([[kb.button('🔁 Recent', CB.logsRecent), kb.button('👤 Mine', CB.logsMine)], backHomeRow(CB.home)]), msgId);
  }
  const lines = list.map(l => {
    const when = new Date(l.createdAtMs || Date.now()).toISOString().slice(11, 19);
    const emoji = l.result === 'success' ? '✅' : '❌';
    return `${emoji} <code>${when}</code> ${escapeHtml(l.module)}:${escapeHtml(l.action)} ${l.target ? '→ ' + escapeHtml(truncate(l.target, 12)) : ''}`;
  }).join('\n');
  await sendOrEdit(chatId, `📋 <b>Logs — ${mode}</b>\n\n${lines}`,
    kb.build([[kb.button('🔁 Recent', CB.logsRecent), kb.button('👤 Mine', CB.logsMine)], backHomeRow(CB.home)]), msgId);
}
