// lib/callbacks.ts
// Central callback_data schema (colon-delimited, <64 bytes).

export const CB = {
  // Navigation
  home:      'nav:home',
  usersMenu: 'nav:users',
  wallet:    'nav:wallet',
  deposit:   'nav:deposit',
  withdraw:  'nav:withdraw',
  games:     'nav:games',
  reports:   'nav:reports',
  broadcast: 'nav:broadcast',
  ai:        'nav:ai',
  server:    'nav:server',
  logs:      'nav:logs',
  redeem:    'nav:redeem',
  cancel:    'nav:cancel',

  // Users
  usersSearch:     'users:search',
  userView:        (uid: string) => `user:v:${uid}`,
  userWallet:      (uid: string) => `user:w:${uid}`,
  userProfile:     (uid: string) => `user:p:${uid}`,
  userEditName:    (uid: string) => `user:en:${uid}`,
  userEditEmail:   (uid: string) => `user:em:${uid}`,
  userEditPhone:   (uid: string) => `user:eph:${uid}`,
  userBanAsk:      (uid: string) => `user:ba:${uid}`,
  userBanConfirm:  (uid: string) => `user:bc:${uid}`,
  userUnbanAsk:    (uid: string) => `user:ua:${uid}`,
  userUnbanConfirm:(uid: string) => `user:uc:${uid}`,
  userDeleteAsk:   (uid: string) => `user:da:${uid}`,
  userDeleteConfirm:(uid: string)=> `user:dc:${uid}`,
  userGames:       (uid: string) => `user:g:${uid}`,
  userTx:          (uid: string) => `user:t:${uid}`,

  // Wallet
  walletLookup:  'wallet:lookup',
  walletAdd:     (uid: string) => `wallet:add:${uid}`,
  walletDeduct:  (uid: string) => `wallet:ded:${uid}`,
  walletPickBalance: (op: 'add' | 'ded', uid: string, bt: string) => `wallet:pb:${op}:${uid}:${bt}`,
  walletConfirm: 'wallet:confirm',

  // Deposit (add-fund)
  depositPending: 'dep:pending',
  depositHistory: 'dep:history',
  depositView:    (id: string) => `dep:v:${id}`,
  depositApproveMenu:   (id: string) => `dep:am:${id}`,
  depositApproveDirect: (id: string) => `dep:ad:${id}`,
  depositApproveCode:   (id: string) => `dep:ac:${id}`,
  depositRejectAsk:     (id: string) => `dep:ra:${id}`,

  // Withdraw
  withdrawPending: 'wd:pending',
  withdrawHistory: 'wd:history',
  withdrawView:    (id: string) => `wd:v:${id}`,
  withdrawApprove: (id: string) => `wd:a:${id}`,
  withdrawApproveConfirm: (id: string) => `wd:ac:${id}`,
  withdrawRejectAsk:      (id: string) => `wd:ra:${id}`,

  // Games (poker / ludo / joker / 9card)
  gamePicker:      (kind: string) => `game:pick:${kind}`,
  gameCreate:      (kind: string) => `game:new:${kind}`,
  gameList:        (kind: string) => `game:ls:${kind}`,
  gameView:        (kind: string, id: string) => `game:v:${kind}:${id}`,
  gameKickAsk:     (kind: string, id: string) => `game:ka:${kind}:${id}`,
  gameRefundAsk:   (kind: string, id: string) => `game:ra:${kind}:${id}`,
  gameRefundConfirm:(kind: string,id: string) => `game:rc:${kind}:${id}`,
  gameEndAsk:      (kind: string, id: string) => `game:ea:${kind}:${id}`,
  gameEndConfirm:  (kind: string, id: string) => `game:ec:${kind}:${id}`,
  gameDeleteAsk:   (kind: string, id: string) => `game:da:${kind}:${id}`,
  gameDeleteConfirm:(kind: string,id: string) => `game:dc:${kind}:${id}`,

  // Redeem codes
  redeemList:    'rd:list',
  redeemActive:  'rd:act',
  redeemCreate:  'rd:new',
  redeemView:    (code: string) => `rd:v:${code}`,
  redeemEmail:   (code: string) => `rd:em:${code}`,
  redeemApply:   (code: string) => `rd:ap:${code}`,
  redeemRevoke:  (code: string) => `rd:rv:${code}`,

  // Reports
  reportUsers:    'rep:users',
  reportRevenue:  'rep:revenue',
  reportDeposit:  'rep:deposit',
  reportWithdraw: 'rep:withdraw',
  reportWallet:   'rep:wallet',
  reportGames:    'rep:games',

  // Broadcast
  broadcastText:  'bc:text',
  broadcastImage: 'bc:image',
  broadcastVideo: 'bc:video',
  broadcastPdf:   'bc:pdf',
  broadcastConfirm:'bc:confirm',

  // AI
  aiChat:    'ai:chat',
  aiCode:    'ai:code',
  aiLogs:    'ai:logs',
  aiDebug:   'ai:debug',
  aiEndChat: 'ai:end',   // exits the conversational loop
  aiAgent:        'ai:agent', // enter agent mode (natural language → tools)
  aiAgentConfirm: 'ai:aconf', // execute the pending write action
  aiAgentCancel:  'ai:acan',  // drop the pending write action
  aiAgentModify:  'ai:amod',  // clear pending, prompt user to rephrase
  aiModel:        'ai:model', // show model picker for current provider
  aiPickModel:    (key: string) => `ai:mp:${key}`, // key is a short alias, see MODEL_CHOICES in router

  // Logs / server
  logsRecent: 'logs:recent',
  logsMine:   'logs:mine',
  serverInfo: 'server:info',
} as const;

/** Parse arbitrary "prefix:action:arg:arg2:…" callback data. */
export function parseCallback(data: string): { module: string; action: string; args: string[] } {
  const parts = data.split(':');
  return {
    module: parts[0] || '',
    action: parts[1] || '',
    args:   parts.slice(2),
  };
}
