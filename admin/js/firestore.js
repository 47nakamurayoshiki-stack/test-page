// Firestore 初期化モジュール
// 既存の Firebase アプリ（auth/js/firebase.js の app）を再利用して Firestore を初期化する。
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
  writeBatch,
  documentId,
  increment
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { app } from "../../auth/js/firebase.js";

export const db = getFirestore(app);

// 問題マスタのコレクション名
export const QUESTIONS_COLLECTION = "questions";
export const EXAM_CONFIGS_COLLECTION = "examConfigs";
export const PERSONALITY_COLLECTION = "personalityQuestions";

// 性格検査の特性（traitキー → 表示名）
export const PERSONALITY_TRAITS = {
  extraversion: "外向性",
  achievement: "達成意欲",
  prudence: "慎重性",
  stability: "情緒安定性",
  originality: "独自性",
  cooperation: "協調性",
  persistence: "持続性"
};

// カテゴリ・難易度の定義（UI のセレクトや検証で再利用）
export const CATEGORIES = [
  { value: "language", label: "言語" },
  { value: "nonverbal", label: "非言語" },
  { value: "english", label: "英語" }
];

export const DIFFICULTIES = [
  { value: "easy", label: "かんたん" },
  { value: "full", label: "本格" }
];

// 1 問分のデータを正規化して保存可能な形にする（フォーム入力 → 保存用オブジェクト）
export function normalizeQuestion(input) {
  const options = (input.options || [])
    .map((opt) => (typeof opt === "string" ? opt.trim() : ""))
    .filter((opt) => opt.length > 0);
  return {
    category: input.category || "",
    subcategory: (input.subcategory || "").trim(),
    difficulty: input.difficulty || "",
    type: input.type || "mc",
    prompt_html: (input.prompt_html || "").trim(),
    options: options,
    answer_index:
      typeof input.answer_index === "number" ? input.answer_index : Number(input.answer_index) || 0,
    explanation_html: (input.explanation_html || "").trim(),
    tags: Array.isArray(input.tags)
      ? input.tags.map((t) => String(t).trim()).filter(Boolean)
      : [],
    active: input.active !== false
  };
}

// 保存前のバリデーション。問題があればエラーメッセージ配列を返す（空配列なら OK）。
export function validateQuestion(q) {
  const errors = [];
  if (!CATEGORIES.some((c) => c.value === q.category)) {
    errors.push("カテゴリを選択してください。");
  }
  if (!DIFFICULTIES.some((d) => d.value === q.difficulty)) {
    errors.push("難易度を選択してください。");
  }
  if (!q.prompt_html) {
    errors.push("設問文を入力してください。");
  }
  if (!Array.isArray(q.options) || q.options.length < 2) {
    errors.push("選択肢は2つ以上入力してください。");
  }
  if (
    typeof q.answer_index !== "number" ||
    q.answer_index < 0 ||
    q.answer_index >= (q.options ? q.options.length : 0)
  ) {
    errors.push("正解の選択肢を指定してください。");
  }
  return errors;
}

// ---- CRUD ----------------------------------------------------------------

function questionsCol() {
  return collection(db, QUESTIONS_COLLECTION);
}

// 一覧取得。filters = { category?, difficulty?, activeOnly? }
export async function listQuestions(filters = {}) {
  const constraints = [];
  if (filters.category) {
    constraints.push(where("category", "==", filters.category));
  }
  if (filters.difficulty) {
    constraints.push(where("difficulty", "==", filters.difficulty));
  }
  if (filters.activeOnly) {
    constraints.push(where("active", "==", true));
  }
  const snap = await getDocs(
    constraints.length ? query(questionsCol(), ...constraints) : questionsCol()
  );
  return snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
}

export async function getQuestion(id) {
  const ref = doc(db, QUESTIONS_COLLECTION, id);
  const snap = await getDoc(ref);
  return snap.exists() ? Object.assign({ id: snap.id }, snap.data()) : null;
}

export async function createQuestion(data, user) {
  const payload = Object.assign({}, normalizeQuestion(data), {
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    createdBy: (user && (user.email || user.uid)) || null
  });
  const ref = await addDoc(questionsCol(), payload);
  return ref.id;
}

export async function updateQuestion(id, data) {
  const ref = doc(db, QUESTIONS_COLLECTION, id);
  const payload = Object.assign({}, normalizeQuestion(data), {
    updatedAt: serverTimestamp()
  });
  await updateDoc(ref, payload);
  return id;
}

export async function setQuestionActive(id, active) {
  const ref = doc(db, QUESTIONS_COLLECTION, id);
  await updateDoc(ref, { active: active === true, updatedAt: serverTimestamp() });
}

export async function removeQuestion(id) {
  await deleteDoc(doc(db, QUESTIONS_COLLECTION, id));
}

// 複数 ID の問題をまとめて削除（バッチ書き込みで効率化）。戻り値は削除件数。
export async function removeQuestionsByIds(ids) {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 450) {
    const chunk = ids.slice(i, i + 450);
    const batch = writeBatch(db);
    chunk.forEach((id) => batch.delete(doc(db, QUESTIONS_COLLECTION, id)));
    await batch.commit();
    deleted += chunk.length;
  }
  return deleted;
}

// 既存 exam/data 形式の問題配列を一括投入（最大 500 件/バッチ）
export async function importQuestions(questions, user) {
  let imported = 0;
  for (let i = 0; i < questions.length; i += 450) {
    const chunk = questions.slice(i, i + 450);
    const batch = writeBatch(db);
    chunk.forEach((raw) => {
      const ref = doc(questionsCol());
      batch.set(
        ref,
        Object.assign({}, normalizeQuestion(raw), {
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          createdBy: (user && (user.email || user.uid)) || null,
          importedFrom: raw.importedFrom || null
        })
      );
    });
    await batch.commit();
    imported += chunk.length;
  }
  return imported;
}

// 復習リスト（ユーザーごと）: users/{uid}/wrongQuestions/{questionId}
// 受験完了時に間違えた問題はここに追加され、正解した問題は削除される。

function wrongCol(uid) {
  return collection(db, "users", uid, "wrongQuestions");
}

// 1問あたり間違えた記録を追加/更新
export async function recordWrongAnswer(uid, question) {
  if (!uid || !question || !question.id) return;
  const ref = doc(db, "users", uid, "wrongQuestions", question.id);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    await updateDoc(ref, {
      wrongCount: increment(1),
      lastWrongAt: serverTimestamp(),
      category: question.category || snap.data().category || null,
      difficulty: question.difficulty || snap.data().difficulty || null,
      subcategory: question.subcategory || snap.data().subcategory || null
    });
  } else {
    await setDoc(ref, {
      questionId: question.id,
      category: question.category || null,
      difficulty: question.difficulty || null,
      subcategory: question.subcategory || null,
      wrongCount: 1,
      addedAt: serverTimestamp(),
      lastWrongAt: serverTimestamp()
    });
  }
}

// 復習リストから削除（正解時の克服）
export async function removeWrongAnswer(uid, questionId) {
  if (!uid || !questionId) return;
  try {
    await deleteDoc(doc(db, "users", uid, "wrongQuestions", questionId));
  } catch (_e) {
    // 存在しない場合などはサイレント
  }
}

// 受験結果1回分を反映：間違えた問題は追加、正解した問題は削除（克服）
export async function applyExamResultToReview(uid, answers, questions) {
  if (!uid || !Array.isArray(answers) || !Array.isArray(questions)) return;
  await Promise.all(
    answers.map(async (a, i) => {
      const q = questions[i];
      if (!q || !q.id) return;
      try {
        if (a && a.isCorrect) {
          await removeWrongAnswer(uid, q.id);
        } else {
          await recordWrongAnswer(uid, q);
        }
      } catch (err) {
        console.warn("review update failed for", q.id, err);
      }
    })
  );
}

// 復習対象の問題IDを取得。filters = { category?, difficulty? }
export async function listWrongQuestionIds(uid, filters = {}) {
  if (!uid) return [];
  const constraints = [];
  if (filters.category) constraints.push(where("category", "==", filters.category));
  if (filters.difficulty) constraints.push(where("difficulty", "==", filters.difficulty));
  const snap = await getDocs(
    constraints.length ? query(wrongCol(uid), ...constraints) : wrongCol(uid)
  );
  return snap.docs.map((d) => d.id);
}

// 復習用：指定 ID リストの questions ドキュメントを取得（10件ごとにバッチで取得）
export async function fetchQuestionsByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const result = [];
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    const snap = await getDocs(query(collection(db, QUESTIONS_COLLECTION), where(documentId(), "in", chunk)));
    snap.docs.forEach((d) => result.push(Object.assign({ id: d.id }, d.data())));
  }
  return result.filter((q) => q.active !== false);
}

// 出題用：指定カテゴリ・難易度の有効な問題をすべて取得（exam-start.js から利用）。
// active のフィルタはクライアント側で行うことで Firestore 複合インデックス不要にしている。
export async function fetchActiveQuestions(category, difficulty) {
  const constraints = [];
  if (category) {
    constraints.push(where("category", "==", category));
  }
  if (difficulty) {
    constraints.push(where("difficulty", "==", difficulty));
  }
  const snap = await getDocs(
    constraints.length ? query(questionsCol(), ...constraints) : questionsCol()
  );
  return snap.docs
    .map((d) => Object.assign({ id: d.id }, d.data()))
    .filter((q) => q.active !== false);
}

// ---- 受験履歴（ユーザーごと）-----------------------------------------------
// users/{uid}/examResults/{resultId} に集計サマリーを保存。
// 結果ページで直近N件を取得して「直近3回の総合分析」を描画する。

function examResultsCol(uid) {
  return collection(db, "users", uid, "examResults");
}

// 受験結果1件保存。data は集計済みのサマリー（軽量）。
export async function saveExamResult(uid, data) {
  if (!uid || !data) return;
  const payload = Object.assign({}, data, {
    savedAt: serverTimestamp()
  });
  const ref = await addDoc(examResultsCol(uid), payload);
  return ref.id;
}

// 直近N件の受験履歴を取得（completedAt 降順）。
export async function listRecentExamResults(uid, limitCount = 3) {
  if (!uid) return [];
  try {
    const snap = await getDocs(
      query(examResultsCol(uid), orderBy("completedAt", "desc"))
    );
    const docs = snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    return docs.slice(0, limitCount);
  } catch (e) {
    console.warn("listRecentExamResults failed", e);
    return [];
  }
}

// 全受験履歴を取得（マイページの学習履歴ダッシュボード用）
export async function listAllExamResults(uid) {
  if (!uid) return [];
  try {
    const snap = await getDocs(
      query(examResultsCol(uid), orderBy("completedAt", "desc"))
    );
    return snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
  } catch (e) {
    console.warn("listAllExamResults failed", e);
    return [];
  }
}

// 偏差値計算用の集計データ（全受験者）。
// aggregate/scores ドキュメントに count / sum / sumSq を category_mode 別に保持。
// 完成時平均は sum/count、分散 = sumSq/count - 平均^2、標準偏差は sqrt(分散)。
export async function updateAggregateScore(category, mode, scorePercent) {
  if (!category || !mode || typeof scorePercent !== "number") return;
  const key = `${category}_${mode}`;
  const ref = doc(db, "aggregate", "scores");
  try {
    const snap = await getDoc(ref);
    const data = snap.exists() ? snap.data() : {};
    const cur = data[key] || { count: 0, sum: 0, sumSq: 0 };
    const next = {
      count: cur.count + 1,
      sum: cur.sum + scorePercent,
      sumSq: cur.sumSq + scorePercent * scorePercent
    };
    if (snap.exists()) {
      await updateDoc(ref, { [key]: next });
    } else {
      await setDoc(ref, { [key]: next });
    }
  } catch (e) {
    console.warn("updateAggregateScore failed", e);
  }
}

// 性格検査の最新結果を保存
export async function savePersonalityResult(uid, result) {
  if (!uid || !result) return;
  const ref = doc(db, "users", uid, "personality", "latest");
  try {
    await setDoc(ref, Object.assign({}, result, { savedAt: serverTimestamp() }));
  } catch (e) {
    console.warn("savePersonalityResult failed", e);
  }
}

// 性格検査の最新結果を取得
export async function getLatestPersonalityResult(uid) {
  if (!uid) return null;
  try {
    const snap = await getDoc(doc(db, "users", uid, "personality", "latest"));
    return snap.exists() ? snap.data() : null;
  } catch (e) {
    console.warn("getLatestPersonalityResult failed", e);
    return null;
  }
}

// 偏差値計算用に集計データを取得
export async function getAggregateScores() {
  try {
    const snap = await getDoc(doc(db, "aggregate", "scores"));
    return snap.exists() ? snap.data() : {};
  } catch (e) {
    console.warn("getAggregateScores failed", e);
    return {};
  }
}

// ---- 性格検査の質問 ----------------------------------------------------------

function personalityCol() {
  return collection(db, PERSONALITY_COLLECTION);
}

// 全質問取得（active のみ）
export async function fetchPersonalityQuestions() {
  const snap = await getDocs(personalityCol());
  return snap.docs
    .map((d) => Object.assign({ id: d.id }, d.data()))
    .filter((q) => q.active !== false);
}

// 一覧（管理画面用、active 関係なく全件）
export async function listPersonalityQuestions() {
  const snap = await getDocs(personalityCol());
  return snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
}

// 1問追加
export async function createPersonalityQuestion(data, user) {
  const payload = Object.assign({}, normalizePersonality(data), {
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    createdBy: (user && (user.email || user.uid)) || null
  });
  const ref = await addDoc(personalityCol(), payload);
  return ref.id;
}

// 一括インポート
export async function importPersonalityQuestions(questions, user) {
  let imported = 0;
  for (let i = 0; i < questions.length; i += 450) {
    const chunk = questions.slice(i, i + 450);
    const batch = writeBatch(db);
    chunk.forEach((raw) => {
      const ref = doc(personalityCol());
      batch.set(
        ref,
        Object.assign({}, normalizePersonality(raw), {
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          createdBy: (user && (user.email || user.uid)) || null,
          importedFrom: raw.importedFrom || null
        })
      );
    });
    await batch.commit();
    imported += chunk.length;
  }
  return imported;
}

// 一括削除
export async function removeAllPersonalityQuestions() {
  const snap = await getDocs(personalityCol());
  const ids = snap.docs.map((d) => d.id);
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 450) {
    const chunk = ids.slice(i, i + 450);
    const batch = writeBatch(db);
    chunk.forEach((id) => batch.delete(doc(db, PERSONALITY_COLLECTION, id)));
    await batch.commit();
    deleted += chunk.length;
  }
  return deleted;
}

function normalizePersonality(input) {
  const direction = String(input.direction || "+").trim();
  return {
    text: (input.text || "").trim(),
    trait: (input.trait || "").trim(),
    direction: direction === "-" || direction === "negative" ? "-" : "+",
    order: typeof input.order === "number" ? input.order : Number(input.order) || 0,
    active: input.active !== false
  };
}

export function validatePersonalityQuestion(q) {
  const errors = [];
  if (!q.text) errors.push("質問文が空");
  if (!q.trait) errors.push("特性キーが空");
  if (!PERSONALITY_TRAITS[q.trait]) errors.push(`特性キーが不正: ${q.trait}`);
  if (q.direction !== "+" && q.direction !== "-") errors.push("方向は + または -");
  return errors;
}

// ---- 専門家マスタ（トップページ「専門家に直接相談できます」） ----------------

export const ADVISORS_COLLECTION = "advisors";

// トップページの初期表示と同じ10名（初期データ投入用）
export const DEFAULT_ADVISORS = [
  { name: "佐々木 亮", tag: "銀行・証券・保険", description: "メガバンク出身。金融業界の選考対策と志望動機づくりが得意。", photo_url: "images/advisors/advisor01.jpg", emoji: "👨‍💼", slug: "finance", order: 1 },
  { name: "高橋 美咲", tag: "外資系金融", description: "外資系金融・投資銀行の面接対策に強い。難関選考の突破実績多数。", photo_url: "images/advisors/advisor02.jpg", emoji: "👩‍💼", slug: "global-finance", order: 2 },
  { name: "田中 大輔", tag: "総合商社・専門商社", description: "商社の内定者を毎年サポート。ケース面接・英語面接にも対応。", photo_url: "images/advisors/advisor03.jpg", emoji: "🌏", slug: "trading", order: 3 },
  { name: "鈴木 彩花", tag: "メーカー", description: "自動車・電機・素材など、隠れた優良BtoBメーカーに詳しい。", photo_url: "images/advisors/advisor04.jpg", emoji: "🏭", slug: "maker", order: 4 },
  { name: "山本 翔太", tag: "IT・Web業界", description: "エンジニア就活からWeb系総合職まで。ポートフォリオ指導も。", photo_url: "images/advisors/advisor05.jpg", emoji: "💻", slug: "it", order: 5 },
  { name: "中村 結衣", tag: "ベンチャー", description: "急成長ベンチャーの人事と太いパイプ。裁量重視の就活に。", photo_url: "images/advisors/advisor06.jpg", emoji: "🚀", slug: "venture", order: 6 },
  { name: "木村 剛", tag: "体育会系・スポーツ", description: "体育会出身。部活と両立できる就活スケジュール設計が得意。", photo_url: "images/advisors/advisor07.jpg", emoji: "⚽", slug: "sports", order: 7 },
  { name: "小林 真央", tag: "コンサルティング", description: "戦略系・総合系コンサルのケース面接対策のプロ。", photo_url: "images/advisors/advisor08.jpg", emoji: "📊", slug: "consulting", order: 8 },
  { name: "渡辺 健", tag: "広告・マスコミ", description: "広告・テレビ・エンタメ業界の選考フローとES添削に強い。", photo_url: "images/advisors/advisor09.jpg", emoji: "🎬", slug: "media", order: 9 },
  { name: "伊藤 さくら", tag: "インフラ・公務員", description: "鉄道・電力・公務員併願など、安定志向の就活をサポート。", photo_url: "images/advisors/advisor10.jpg", emoji: "🏛️", slug: "infra", order: 10 }
];

export function normalizeAdvisor(input) {
  return {
    company: (input.company || "").trim(),
    name: (input.name || "").trim(),
    tag: (input.tag || "").trim(),
    description: (input.description || "").trim(),
    photo_url: (input.photo_url || "").trim(),
    emoji: (input.emoji || "").trim() || "👤",
    slug: (input.slug || "").trim(),
    order: typeof input.order === "number" ? input.order : Number(input.order) || 0,
    active: input.active !== false
  };
}

export function validateAdvisor(a) {
  const errors = [];
  if (!a.name) errors.push("名前を入力してください。");
  if (!a.tag) errors.push("得意領域（タグ）を入力してください。");
  if (!a.description) errors.push("紹介文を入力してください。");
  return errors;
}

function advisorsCol() {
  return collection(db, ADVISORS_COLLECTION);
}

// 管理画面用：全件取得（並び順 → 名前順）
export async function listAdvisors() {
  const snap = await getDocs(advisorsCol());
  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  items.sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.name).localeCompare(b.name, "ja"));
  return items;
}

export async function createAdvisor(data, user) {
  const ref = await addDoc(advisorsCol(), {
    ...data,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    createdBy: user ? user.email || user.uid : null
  });
  return ref.id;
}

export async function updateAdvisor(id, data) {
  await updateDoc(doc(db, ADVISORS_COLLECTION, id), {
    ...data,
    updatedAt: serverTimestamp()
  });
}

export async function setAdvisorActive(id, active) {
  await updateDoc(doc(db, ADVISORS_COLLECTION, id), { active: !!active, updatedAt: serverTimestamp() });
}

export async function removeAdvisor(id) {
  await deleteDoc(doc(db, ADVISORS_COLLECTION, id));
}

// 初期データ投入（既存データがある場合は投入しない）
export async function seedDefaultAdvisors(user) {
  const existing = await getDocs(advisorsCol());
  if (!existing.empty) {
    return { seeded: 0, skipped: existing.size };
  }
  const batch = writeBatch(db);
  DEFAULT_ADVISORS.forEach((a) => {
    const ref = doc(advisorsCol());
    batch.set(ref, {
      ...normalizeAdvisor(a),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: user ? user.email || user.uid : null
    });
  });
  await batch.commit();
  return { seeded: DEFAULT_ADVISORS.length, skipped: 0 };
}

// トップページ用：表示中（active）の専門家を並び順で取得
export async function fetchActiveAdvisors() {
  const snap = await getDocs(advisorsCol());
  const items = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((a) => a.active !== false);
  items.sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.name).localeCompare(b.name, "ja"));
  return items;
}

// ---- 専門家への問い合わせ計測 ------------------------------------------------
// 相談フォーム送信時に ?advisor=<docId または slug> をキーとしてカウントする。

export const ADVISOR_INQUIRIES_COLLECTION = "advisorInquiries";

export async function recordAdvisorInquiry(advisorKey) {
  const key = String(advisorKey || "").trim();
  if (!key) return;
  await setDoc(
    doc(db, ADVISOR_INQUIRIES_COLLECTION, key),
    { count: increment(1), lastAt: serverTimestamp() },
    { merge: true }
  );
}

// 管理画面用：キー（docId/slug）→ { count, lastAt } のマップを返す
export async function getAdvisorInquiryCounts() {
  const snap = await getDocs(collection(db, ADVISOR_INQUIRIES_COLLECTION));
  const map = {};
  snap.docs.forEach((d) => {
    const data = d.data();
    map[d.id] = {
      count: data.count || 0,
      lastAt: data.lastAt && data.lastAt.toDate ? data.lastAt.toDate() : null
    };
  });
  return map;
}
