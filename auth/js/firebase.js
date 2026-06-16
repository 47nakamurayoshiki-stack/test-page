// Firebase app + auth bootstrap (ESM modules loaded from gstatic CDN)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendEmailVerification, sendPasswordResetEmail, signOut, reload,
  verifyBeforeUpdateEmail, updatePassword, EmailAuthProvider, reauthenticateWithCredential,
  applyActionCode
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export { applyActionCode };

// small helpers
export const helpers = {
  async ensureFreshUser() {
    if (!auth.currentUser) return null;
    await reload(auth.currentUser);
    return auth.currentUser;
  },
  requireAuth(redirectTo = "signin.html") {
    return new Promise((resolve) => {
      const unsub = onAuthStateChanged(auth, (user) => {
        unsub();
        if (!user) {
          window.location.href = redirectTo;
        } else {
          resolve(user);
        }
      });
    });
  },
  async requireVerified(redirectIfUnverified = "verify_email.html") {
    const user = await this.requireAuth();
    await reload(user);
    if (!user.emailVerified) {
      window.location.href = redirectIfUnverified;
      return null;
    }
    return user;
  },
  async reauthWithPassword(currentPassword) {
    const user = auth.currentUser;
    if (!user || !user.email) throw new Error("Not signed in");
    const cred = EmailAuthProvider.credential(user.email, currentPassword);
    await reauthenticateWithCredential(user, cred);
    return user;
  }
};

export const api = {
  signUp: async (email, password) => {
    const res = await createUserWithEmailAndPassword(auth, email, password);
    await sendEmailVerification(res.user);
    return res.user;
  },
  signIn: async (email, password) => {
    const res = await signInWithEmailAndPassword(auth, email, password);
    await reload(res.user);
    return res.user;
  },
  resendVerification: async () => {
    if (!auth.currentUser) throw new Error("Not signed in");
    await sendEmailVerification(auth.currentUser);
  },
  updateEmailWithReauth: async (currentPassword, newEmail) => {
    const user = await helpers.reauthWithPassword(currentPassword);
    await verifyBeforeUpdateEmail(user, newEmail);
  },
  updatePasswordWithReauth: async (currentPassword, newPassword) => {
    await helpers.reauthWithPassword(currentPassword);
    await updatePassword(auth.currentUser, newPassword);
  },
  signOut: () => signOut(auth),
  sendReset: (email) => sendPasswordResetEmail(auth, email),
};
