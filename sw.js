/**
 * sw.js — ASChat Service Worker v5
 *
 * Fixes in v5:
 *  - Scope-agnostic: works whether served from / or /ASCHATS/ or any subpath
 *  - notificationclick: uses self.location.origin + relative URL correctly
 *  - isClientFocusedOnChat: no longer relies on client.focused (unreliable on Android)
 *  - Better cache strategy: network-first for HTML, cache-first for assets
 *  - Handles 'dismiss' action same as 'close' on all notification types
 */

const CACHE_VERSION = 'aschat-v7';
const STATE_CACHE   = 'aschat-sw-state-v2';
const STATE_URL     = '/__sw_state__';
const SW_BASE = self.location.pathname.replace(/\/sw\.js$/, '') || '';

// Assets to precache on install — paths relative to SW location
const STATIC_ASSETS = [
  SW_BASE + '/',
  SW_BASE + '/index.html',
  SW_BASE + '/auth.html',
  SW_BASE + '/chats.html',
  SW_BASE + '/chat.html',
  SW_BASE + '/profile.html',
  SW_BASE + '/other-profile.html',
  SW_BASE + '/css/style.css',
  SW_BASE + '/manifest.json',
  SW_BASE + '/js/auth.js',
  SW_BASE + '/js/chat.js',
  SW_BASE + '/js/chats.js',
  SW_BASE + '/js/call.js',
  SW_BASE + '/js/global-call.js',
  SW_BASE + '/js/profile.js',
  SW_BASE + '/js/other-profile.js',
  SW_BASE + '/js/pwa.js',
  SW_BASE + '/js/storage.js',
  SW_BASE + '/js/firebase-config.js',
  SW_BASE + '/js/notifications.js',
  SW_BASE + '/icons/icon-192.png',
  SW_BASE + '/icons/icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css'
];

// ─── INSTALL ──────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      return Promise.allSettled(
        STATIC_ASSETS.map(url =>
          cache.add(url).catch(err => console.warn('[SW] Cache miss:', url, err.message))
        )
      );
    })
  );
  // Take over immediately — don't wait for old SW to be idle
  self.skipWaiting();
});

// ─── ACTIVATE ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_VERSION && k !== STATE_CACHE)
          .map(k => caches.delete(k))
      )
    )
  );
  // Claim all open clients immediately so new SW controls existing tabs
  self.clients.claim();
});

// ─── FETCH ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = event.request.url;

  // Never intercept Firebase or external API calls
  if (
    url.includes('firebaseio.com') ||
    url.includes('googleapis.com') ||
    url.includes('gstatic.com/firebasejs') ||
    url.includes('firebase') ||
    url.includes('fcm.googleapis')
  ) return;

  // HTML pages: network-first, fallback to cache
  if (event.request.destination === 'document') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then(c => c.put(event.request, clone));
          }
          return response;
        })
        .catch(() =>
          caches.match(event.request).then(cached =>
            cached || caches.match(SW_BASE + '/chats.html')
          )
        )
    );
    return;
  }

  // Assets: cache-first, update in background
  event.respondWith(
    caches.match(event.request).then(cached => {
      const fetchPromise = fetch(event.request).then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then(c => c.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);

      return cached || fetchPromise;
    })
  );
});

// ─── WEB PUSH EVENT (app fully closed) ───────────────────────────────────────
// This fires when the Railway backend calls webpush.sendNotification().
// The browser/OS wakes this service worker even if no tab is open.
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch (e) {
    console.warn('[SW] Bad push payload:', e);
    return;
  }

  if (!data.type) return;

  event.waitUntil((async () => {
    // If the user is already viewing this chat, suppress the notification
    const focused = data.senderID ? await isClientFocusedOnChat(data.senderID) : false;
    if (focused) return;

    switch (data.type) {
      case 'message':
        return showMessageNotification({
          senderName:  data.senderName,
          senderID:    data.senderID,
          text:        data.body || data.text || 'New message',
          senderPhoto: data.senderPhoto || null,
          timestamp:   data.timestamp || Date.now()
        });
      case 'photo':
        return showPhotoNotification({
          senderName:  data.senderName,
          senderID:    data.senderID,
          senderPhoto: data.senderPhoto || null,
          timestamp:   data.timestamp || Date.now()
        });
      case 'voice':
        return showVoiceNotification({
          senderName:  data.senderName,
          senderID:    data.senderID,
          senderPhoto: data.senderPhoto || null,
          timestamp:   data.timestamp || Date.now()
        });
      case 'call':
        return showCallNotification({
          callerName:  data.senderName,
          callerID:    data.senderID,
          callType:    data.callType || 'voice',
          callerPhoto: data.senderPhoto || null,
          timestamp:   data.timestamp || Date.now()
        });
      case 'missed_call':
        return showMissedCallNotification({
          callerName:  data.senderName,
          callerID:    data.senderID,
          callType:    data.callType || 'voice',
          callerPhoto: data.senderPhoto || null,
          timestamp:   data.timestamp || Date.now()
        });
      case 'reaction':
        return showReactionNotification({
          senderName:  data.senderName,
          senderID:    data.senderID,
          emoji:       data.emoji || '❤️',
          senderPhoto: data.senderPhoto || null,
          timestamp:   data.timestamp || Date.now()
        });
      default:
        // Generic fallback
        return self.registration.showNotification(data.title || 'ASChat', {
          body:   data.body || 'New notification',
          icon:   SW_BASE + '/icons/icon-192.png',
          badge:  SW_BASE + '/icons/icon-192.png',
          tag:    'aschat-generic',
          data:   { url: SW_BASE + '/chats.html' }
        });
    }
  })());
});

// ─── MESSAGE FROM PAGE ────────────────────────────────────────────────────────
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || !data.type) return;

  switch (data.type) {
    case 'NOTIFY_MESSAGE':      showMessageNotification(data);     break;
    case 'NOTIFY_PHOTO':        showPhotoNotification(data);       break;
    case 'NOTIFY_VOICE':        showVoiceNotification(data);       break;
    case 'NOTIFY_CALL':         showCallNotification(data);        break;
    case 'DISMISS_CALL':        dismissCallNotification(data.callerID); break;
    case 'NOTIFY_MISSED_CALL':  showMissedCallNotification(data);  break;
    case 'NOTIFY_REACTION':     showReactionNotification(data);    break;
    case 'CLEAR_NOTIFICATIONS': clearNotificationsForChat(data.otherID); break;

    case 'UPDATE_UNREAD_STATE':
      swState.totalUnread  = data.totalUnread  || 0;
      swState.unreadChats  = data.unreadChats  || [];
      swState.lastActiveAt = data.lastActiveAt || swState.lastActiveAt;
      swState.userName     = data.userName     || '';
      persistState();
      break;

    case 'USER_ACTIVE':
      swState.lastActiveAt          = Date.now();
      swState.lastReengagementShown = 0;
      persistState();
      cancelReengagementNotification();
      break;
  }
});

// ─── SW STATE (persisted across restarts) ────────────────────────────────────
const swState = {
  totalUnread:           0,
  unreadChats:           [],
  lastActiveAt:          0,
  lastReengagementShown: 0,
  userName:              ''
};


async function persistState() {
  try {
    const cache = await caches.open(STATE_CACHE);
    await cache.put(STATE_URL, new Response(JSON.stringify(swState), {
      headers: { 'Content-Type': 'application/json' }
    }));
  } catch (e) {}
}

async function restoreState() {
  try {
    const cache = await caches.open(STATE_CACHE);
    const res   = await cache.match(STATE_URL);
    if (!res) return;
    const saved = await res.json();
    Object.assign(swState, saved);
  } catch (e) {}
}

// ─── PERIODIC SYNC ────────────────────────────────────────────────────────────
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'aschat-reengagement') {
    event.waitUntil(restoreState().then(() => maybeShowReengagement()));
  }
});

// ─── BACKGROUND SYNC (online fallback) ────────────────────────────────────────
self.addEventListener('sync', (event) => {
  if (event.tag === 'aschat-reengagement') {
    event.waitUntil(restoreState().then(() => maybeShowReengagement()));
  }
});

// ─── RE-ENGAGEMENT ────────────────────────────────────────────────────────────
const REENGAGEMENT_MIN_AWAY_MS = 15 * 60 * 1000;
const REENGAGEMENT_COOLDOWN_MS = 60 * 60 * 1000;
const REENGAGEMENT_TAG         = 'reengagement';

async function maybeShowReengagement() {
  const appOpen = await isAppOpen();
  if (appOpen) return;

  const now = Date.now();
  if (swState.lastActiveAt && (now - swState.lastActiveAt) < REENGAGEMENT_MIN_AWAY_MS) return;
  if (swState.lastReengagementShown && (now - swState.lastReengagementShown) < REENGAGEMENT_COOLDOWN_MS) return;
  if (swState.totalUnread <= 0) return;

  const existing = await self.registration.getNotifications();
  const hasRealNotif = existing.some(n => n.tag && (n.tag.startsWith('msg-') || n.tag.startsWith('call-')));
  if (hasRealNotif) return;

  swState.lastReengagementShown = now;
  await persistState();
  await showReengagementNotification();
}

async function showReengagementNotification() {
  const total = swState.totalUnread;
  const chats = swState.unreadChats || [];
  let title = 'ASChat', body = '';

  if (chats.length === 1) {
    title = `ASChat — ${chats[0].name}`;
    body  = total === 1 ? 'You have 1 unread message' : `You have ${total} unread messages`;
  } else if (chats.length === 2) {
    body = `${chats[0].name} and ${chats[1].name} sent you messages`;
  } else if (chats.length > 2) {
    const others = chats.length - 2;
    body = `${chats[0].name}, ${chats[1].name} and ${others} other${others > 1 ? 's' : ''} sent you messages`;
  } else {
    body = `You have ${total} unread message${total > 1 ? 's' : ''}`;
  }

  await self.registration.showNotification(title, {
    body,
    icon:      chats.length === 1 && chats[0].photo ? chats[0].photo : SW_BASE + '/icons/icon-192.png',
    badge:     SW_BASE + '/icons/icon-192.png',
    tag:       REENGAGEMENT_TAG,
    renotify:  false,
    silent:    false,
    vibrate:   [200, 100, 200],
    timestamp: Date.now(),
    data: { type: 'reengagement', url: SW_BASE + '/chats.html' },
    actions: [
      { action: 'open',    title: '💬 Open ASChat' },
      { action: 'dismiss', title: '✕ Dismiss'      }
    ]
  });
}

function cancelReengagementNotification() {
  self.registration.getNotifications({ tag: REENGAGEMENT_TAG })
    .then(notifs => notifs.forEach(n => n.close()))
    .catch(() => {});
}

// ─── NOTIFICATION BUILDERS ────────────────────────────────────────────────────

async function showMessageNotification(data) {
  const { senderName, senderID, text, senderPhoto, timestamp } = data;
  const focused = await isClientFocusedOnChat(senderID);
  if (focused) return;

  // Close re-engagement — real message takes priority
  const reeng = await self.registration.getNotifications({ tag: REENGAGEMENT_TAG });
  reeng.forEach(n => n.close());

  const chatURL = buildChatURL(senderID, senderName);

  await self.registration.showNotification(`ASChat — ${senderName}`, {
    body:      text || 'New message',
    icon:      senderPhoto || SW_BASE + '/icons/icon-192.png',
    badge:     SW_BASE + '/icons/icon-192.png',
    tag:       'msg-' + senderID,
    renotify:  true,
    silent:    false,
    vibrate:   [200, 100, 200],
    timestamp: timestamp || Date.now(),
    data:      { type: 'message', senderID, senderName, url: chatURL },
    actions: [
      { action: 'open',  title: '💬 Open'    },
      { action: 'close', title: '✕ Dismiss'  }
    ]
  });
}

async function showPhotoNotification(data) {
  data.text = '📷 Photo';
  return showMessageNotification(data);
}

async function showVoiceNotification(data) {
  data.text = '🎤 Voice message';
  return showMessageNotification(data);
}

async function showCallNotification(data) {
  const { callerName, callerID, callType, callerPhoto, timestamp } = data;
  const icon  = callType === 'video' ? '📹' : '📞';
  const label = callType === 'video' ? 'Incoming Video Call' : 'Incoming Voice Call';

  const chatURL = buildChatURL(callerID, callerName) + `&autocall=accept&calltype=${callType}`;

  await self.registration.showNotification(`${icon} ${callerName} is calling...`, {
    body:               label,
    icon:               callerPhoto || SW_BASE + '/icons/icon-192.png',
    badge:              SW_BASE + '/icons/icon-192.png',
    tag:                'call-' + callerID,
    renotify:           true,
    requireInteraction: true,   // Stays on screen until user acts — like WhatsApp
    silent:             false,
    vibrate:            [500, 200, 500, 200, 500, 200, 500],
    timestamp:          timestamp || Date.now(),
    data: { type: 'call', callerID, callerName, callType, url: chatURL },
    actions: [
      { action: 'accept',  title: '✅ Accept'  },
      { action: 'decline', title: '❌ Decline' }
    ]
  });
}

async function dismissCallNotification(callerID) {
  const notifs = await self.registration.getNotifications({ tag: 'call-' + callerID });
  notifs.forEach(n => n.close());
}

async function showMissedCallNotification(data) {
  const { callerName, callerID, callType, callerPhoto, timestamp } = data;

  // Close the ringing call notification first
  await dismissCallNotification(callerID);

  const icon    = callType === 'video' ? '📹' : '📞';
  const chatURL = buildChatURL(callerID, callerName);

  await self.registration.showNotification(`Missed call from ${callerName}`, {
    body:      `${icon} You missed a ${callType} call`,
    icon:      callerPhoto || SW_BASE + '/icons/icon-192.png',
    badge:     SW_BASE + '/icons/icon-192.png',
    tag:       'missed-' + callerID,
    renotify:  true,
    silent:    false,
    vibrate:   [200, 100, 200],
    timestamp: timestamp || Date.now(),
    data: { type: 'message', senderID: callerID, senderName: callerName, url: chatURL },
    actions: [
      { action: 'open',  title: '💬 Open Chat' },
      { action: 'close', title: '✕ Dismiss'    }
    ]
  });
}

async function showReactionNotification(data) {
  const { senderName, senderID, emoji, senderPhoto, timestamp } = data;
  const focused = await isClientFocusedOnChat(senderID);
  if (focused) return;

  const chatURL = buildChatURL(senderID, senderName);

  await self.registration.showNotification(`${senderName} reacted to your message`, {
    body:      `${emoji}`,
    icon:      senderPhoto || SW_BASE + '/icons/icon-192.png',
    badge:     SW_BASE + '/icons/icon-192.png',
    tag:       'reaction-' + senderID,
    renotify:  true,
    silent:    true,
    vibrate:   [100],
    timestamp: timestamp || Date.now(),
    data: { type: 'message', senderID, senderName, url: chatURL },
    actions: [
      { action: 'open',  title: '💬 Open'   },
      { action: 'close', title: '✕ Dismiss' }
    ]
  });
}

async function clearNotificationsForChat(otherID) {
  const tags = ['msg-' + otherID, 'missed-' + otherID, 'reaction-' + otherID];
  for (const tag of tags) {
    const notifs = await self.registration.getNotifications({ tag });
    notifs.forEach(n => n.close());
  }
}

// ─── NOTIFICATION CLICK ───────────────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  const notification = event.notification;
  const action       = event.action;
  const data         = notification.data || {};

  notification.close();

  // Decline call: send message to any open window so it can fire the decline RTC signal
  if (data.type === 'call' && action === 'decline') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        if (clients.length > 0) {
          clients.forEach(c => c.postMessage({ type: 'DECLINE_CALL_FROM_NOTIFICATION', callerID: data.callerID }));
        } else {
          // No window open — open chat so user can see missed call
          const chatURL = buildChatURL(data.callerID, data.callerName);
          return self.clients.openWindow(chatURL);
        }
      })
    );
    return;
  }

  // Dismiss / close — just close, no navigation
  if (action === 'close' || action === 'dismiss') return;

  // 'open', 'accept', or tap on notification body — navigate to chat
  const targetURL = data.url || (SW_BASE + '/chats.html');

  event.waitUntil(navigateToURL(targetURL));
});

// ─── NOTIFICATION CLOSE ───────────────────────────────────────────────────────
self.addEventListener('notificationclose', (event) => {
  // If user dismisses a call notification (swipes away), treat as decline
  if (event.notification.tag && event.notification.tag.startsWith('call-')) {
    const data = event.notification.data || {};
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients =>
      clients.forEach(c => c.postMessage({ type: 'DECLINE_CALL_FROM_NOTIFICATION', callerID: data.callerID }))
    );
  }
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Build a chat URL that works regardless of hosting subpath.
 * SW_BASE is computed from sw.js's own location.
 */
function buildChatURL(userID, userName) {
  return `${SW_BASE}/chat.html?id=${encodeURIComponent(userID)}&name=${encodeURIComponent(userName || '')}`;
}

/**
 * Navigate an existing window to targetURL or open a new one.
 */
async function navigateToURL(targetURL) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

  // Try to find an existing window at the exact chat URL
  const targetPath   = new URL(targetURL, self.location.origin);
  const targetID     = targetPath.searchParams.get('id');
  const targetIsChat = targetPath.pathname.endsWith('chat.html');

  for (const client of clients) {
    try {
      const clientURL = new URL(client.url);
      const clientID  = clientURL.searchParams.get('id');
      if (targetIsChat && clientID && clientID === targetID) {
        return client.focus();
      }
    } catch (e) {}
  }

  // Navigate any open app window
  for (const client of clients) {
    if ('navigate' in client) {
      try {
        return (await client.navigate(targetURL)).focus();
      } catch (e) {}
    }
  }

  // Open fresh window
  return self.clients.openWindow(targetURL);
}

async function isAppOpen() {
  try {
    const clients = await self.clients.matchAll({ type: 'window' });
    return clients.length > 0 && clients.some(c => c.visibilityState === 'visible');
  } catch (e) { return false; }
}

/**
 * FIX: Don't use client.focused — unreliable on Android Chrome.
 * Instead check if a window is open on the correct chat URL,
 * and whether the page is visible (not hidden/backgrounded).
 */
async function isClientFocusedOnChat(otherID) {
  try {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if (client.visibilityState !== 'visible') continue;
      try {
        const url = new URL(client.url);
        if (url.pathname.endsWith('chat.html') &&
            url.searchParams.get('id') === String(otherID)) {
          return true;
        }
      } catch (e) {}
    }
  } catch (e) {}
  return false;
}
