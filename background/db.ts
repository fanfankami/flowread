/**
 * 扩展侧的本地数据库（IndexedDB）。
 *
 * 这里的位置非常关键：本文件只会被打包进 service worker，
 * 因此数据库属于 **扩展 origin**（chrome-extension://<id>）。
 *
 * 如果把它放到 content script 里，IndexedDB 会挂在宿主页面的 origin 下，
 * 后果是：跨站点读不到彼此的数据、用户清站点数据就全丢、
 * 而且页面自己的 JS 能直接读到用户的聊天原文。
 */
import { DB_NAME, DB_VERSION } from '@/shared/constants';
import type { Anchor, ChatMessage, Conversation } from '@/types';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains('conversations')) {
        const store = db.createObjectStore('conversations', { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      }

      if (!db.objectStoreNames.contains('messages')) {
        const store = db.createObjectStore('messages', { keyPath: 'id' });
        store.createIndex('conversationId', 'conversationId');
      }

      if (!db.objectStoreNames.contains('cache')) {
        db.createObjectStore('cache', { keyPath: 'key' });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // service worker 休眠/升级后旧连接会失效，必须重置缓存，否则后续写入静默失败
      db.onclose = () => {
        dbPromise = null;
      };
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error('无法打开本地数据库'));
    };
  });

  return dbPromise;
}

function runTransaction<T>(storeNames: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T> | T): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeNames, mode);
        let result: T;

        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error ?? new Error('本地数据库事务失败'));
        tx.onabort = () => reject(tx.error ?? new Error('本地数据库事务中止'));

        Promise.resolve(work(tx))
          .then((value) => {
            result = value;
          })
          .catch((error) => {
            try {
              tx.abort();
            } catch {
              // 事务可能已经结束，忽略
            }
            reject(error);
          });
      }),
  );
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('本地数据库请求失败'));
  });
}

export function newId(): string {
  return crypto.randomUUID();
}

/* ------------------------------------------------------------------ */
/* 会话                                                                */
/* ------------------------------------------------------------------ */

export async function createConversation(anchor: Anchor): Promise<Conversation> {
  const now = Date.now();
  const headingPart = (anchor.heading ?? '').replace(/\s+/g, ' ').trim();
  const textPart = anchor.text.replace(/\s+/g, ' ').trim();

  // 标题必须用**选中的原文**，不能用章节名。
  // 同一章里划十段，章节名全都一样，历史列表就变成十个同名条目，完全分不清。
  const title = textPart.slice(0, 46) || headingPart || '未命名对话';

  const conversation: Conversation = {
    id: newId(),
    title,
    url: anchor.url,
    pageTitle: anchor.pageTitle,
    anchor,
    createdAt: now,
    updatedAt: now,
    summary: null,
    compressedCount: 0,
    messageCount: 0,
  };

  await runTransaction(['conversations'], 'readwrite', (tx) => {
    tx.objectStore('conversations').put(conversation);
  });

  return conversation;
}

export function getConversation(id: string): Promise<Conversation | null> {
  return runTransaction(['conversations'], 'readonly', async (tx) => {
    const value = await requestToPromise<Conversation | undefined>(tx.objectStore('conversations').get(id));
    return value ?? null;
  });
}

export function listConversations(limit = 50): Promise<Conversation[]> {
  return runTransaction(['conversations'], 'readonly', async (tx) => {
    const store = tx.objectStore('conversations');
    const index = store.index('updatedAt');
    const collected: Conversation[] = [];

    return new Promise<Conversation[]>((resolve, reject) => {
      const cursorRequest = index.openCursor(null, 'prev');
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor || collected.length >= limit) {
          resolve(collected);
          return;
        }
        collected.push(cursor.value as Conversation);
        cursor.continue();
      };
      cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('读取会话失败'));
    });
  });
}

export async function deleteConversation(id: string): Promise<void> {
  await runTransaction(['conversations', 'messages'], 'readwrite', (tx) => {
    tx.objectStore('conversations').delete(id);
    const messageIndex = tx.objectStore('messages').index('conversationId');
    const cursorRequest = messageIndex.openCursor(IDBKeyRange.only(id));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
  });
}

export async function clearAllConversations(): Promise<void> {
  await runTransaction(['conversations', 'messages', 'cache'], 'readwrite', (tx) => {
    tx.objectStore('conversations').clear();
    tx.objectStore('messages').clear();
    tx.objectStore('cache').clear();
  });
}

export async function touchConversation(
  id: string,
  patch: Partial<Pick<Conversation, 'summary' | 'compressedCount' | 'messageCount' | 'title'>>,
): Promise<void> {
  await runTransaction(['conversations'], 'readwrite', async (tx) => {
    const store = tx.objectStore('conversations');
    const current = await requestToPromise<Conversation | undefined>(store.get(id));
    if (!current) return;
    store.put({ ...current, ...patch, updatedAt: Date.now() });
  });
}

/* ------------------------------------------------------------------ */
/* 消息                                                                */
/* ------------------------------------------------------------------ */

export async function appendMessage(message: ChatMessage): Promise<void> {
  await runTransaction(['messages'], 'readwrite', (tx) => {
    tx.objectStore('messages').put(message);
  });
}

export async function updateMessage(id: string, patch: Partial<ChatMessage>): Promise<void> {
  await runTransaction(['messages'], 'readwrite', async (tx) => {
    const store = tx.objectStore('messages');
    const current = await requestToPromise<ChatMessage | undefined>(store.get(id));
    if (!current) return;
    store.put({ ...current, ...patch });
  });
}

export async function deleteMessage(id: string): Promise<void> {
  await runTransaction(['messages'], 'readwrite', (tx) => {
    tx.objectStore('messages').delete(id);
  });
}

export function listMessages(conversationId: string): Promise<ChatMessage[]> {
  return runTransaction(['messages'], 'readonly', async (tx) => {
    const index = tx.objectStore('messages').index('conversationId');
    const rows = await requestToPromise<ChatMessage[]>(index.getAll(IDBKeyRange.only(conversationId)));
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  });
}

/* ------------------------------------------------------------------ */
/* 回答缓存                                                            */
/* ------------------------------------------------------------------ */

/**
 * 缓存同一段文字的解释结果。
 * 没有这层，用户读一篇八股文划 30 次就是 30 次计费，成本会失控。
 */
export function getCachedAnswer(key: string): Promise<string | null> {
  return runTransaction(['cache'], 'readonly', async (tx) => {
    const row = await requestToPromise<{ key: string; value: string } | undefined>(tx.objectStore('cache').get(key));
    return row?.value ?? null;
  });
}

export async function setCachedAnswer(key: string, value: string): Promise<void> {
  await runTransaction(['cache'], 'readwrite', (tx) => {
    tx.objectStore('cache').put({ key, value, createdAt: Date.now() });
  });
}
