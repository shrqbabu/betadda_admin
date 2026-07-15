// lib/firebase.ts
// Firebase Admin SDK singleton (safe across Vercel serverless warm invocations).

import * as admin from 'firebase-admin';
import { config } from './config';

let app: admin.app.App | null = null;

export function firebaseApp(): admin.app.App {
  if (app) return app;

  if (admin.apps.length > 0 && admin.apps[0]) {
    app = admin.apps[0];
    return app;
  }

  app = admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   config.firebase.projectId,
      clientEmail: config.firebase.clientEmail,
      privateKey:  config.firebase.privateKey,
    }),
    projectId: config.firebase.projectId,
  });

  return app;
}

export function db(): admin.firestore.Firestore {
  const instance = firebaseApp().firestore();
  // Ignore undefined properties so partial docs write cleanly.
  try {
    instance.settings({ ignoreUndefinedProperties: true });
  } catch {
    // settings() throws if already applied — safe to ignore.
  }
  return instance;
}

export function auth(): admin.auth.Auth {
  return firebaseApp().auth();
}

export const FieldValue = admin.firestore.FieldValue;
export const Timestamp  = admin.firestore.Timestamp;

export type Firestore = admin.firestore.Firestore;
export type DocRef    = admin.firestore.DocumentReference;
export type Query     = admin.firestore.Query;
