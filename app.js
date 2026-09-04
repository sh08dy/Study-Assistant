const storeKey = "study-assistant-v1";
const durations = { focus: 25 * 60, short: 5 * 60, long: 15 * 60 };
const modeLabels = { focus: "Focusing", break: "On Break" };

// Simple IndexedDB Helper for large deck files
const idb = {
  dbName: "study-assistant-db",
  storeName: "decks",
  
  _getDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };
      request.onsuccess = (e) => resolve(e.target.result);
      request.onerror = (e) => reject(e.target.error);
    });
  },
  
  async get(key) {
    const db = await this._getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const store = tx.objectStore(this.storeName);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  
  async set(key, val) {
    const db = await this._getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      const req = store.put(val, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },
  
  async delete(key) {
    const db = await this._getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },

  async keys() {
    const db = await this._getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const store = tx.objectStore(this.storeName);
      const req = store.getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
};

let currentStudyDeck = null;
let currentStudyCards = [];
let currentCardIndex = 0;
let cardFlipped = false;
let cardShownTime = null;
const collapsedDecks = new Set();

function getLocalDateString(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

const defaultData = () => ({
  studySeconds: 0,
  studyGoal: 360,
  flashcards: 124,
  retention: 83,
  focusScore: 87,
  streak: 0,
  bestStreak: 0,
  timerMode: "focus",
  timerRemaining: 25 * 60,
  timerSession: 0,
  timerRunning: false,
  sound: true,
  focusMode: true,
  timerFocusDurationMin: 25,
  timerBreakDurationMin: 5,
  timerTargetSessions: 4,
  notesList: [],
  unlinkedNotes: [],
  isHost: false,
  subjects: [
    { name: "Pathology", value: 72, color: "purple" },
    { name: "Anatomy", value: 55, color: "mint" },
    { name: "Biochemistry", value: 40, color: "amber" },
    { name: "Physiology", value: 88, color: "purple" },
    { name: "Pharmacology", value: 30, color: "red" }
  ],
  week: [false, false, false, false, false, false, false],
  tasks: [
    { title: "Review lymphoma slides", tag: "Path", done: true },
    { title: "Anki - cardiac drugs", tag: "Pharm", done: true },
    { title: "MCQs - renal pathology", tag: "Path", done: false },
    { title: "Notes - GI bleeding", tag: "Path", done: false },
    { title: "Past paper 2023 block 3", tag: "Exam", done: false }
  ],
  dailyStudy: {},
  dailySessions: {},
  sessionsToday: 0,
  lastActiveDate: getLocalDateString(),
  flashcardDecks: {},
  flashcardsToday: 0,
  flashcardsGoal: 50,
  flashcardRatings: { easy: 0, good: 0, hard: 0 },
  flashcardTotalTime: 0,
  flashcardTotalCount: 0,
  dailyFlashcards: {},
  calendarEvents: []
});

// Supabase Cloud Configuration
const rawSupabaseUrl = "https://laqusehbufgidoqbfjyq.supabase.co/rest/v1/";
const SUPABASE_URL = rawSupabaseUrl.replace(/\/rest\/v1\/?$/, "");
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxhcXVzZWhidWZnaWRvcWJmanlxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg1NDg5MTEsImV4cCI6MjEwNDEyNDkxMX0.sKmq5h_8NV_I9CjnjPBRJjJVjyRYRNnjCT5plMhLBig";

let supabaseClient = null;
try {
  if (window.supabase && typeof window.supabase.createClient === "function") {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
} catch (e) {
  console.error("Failed to initialize Supabase client:", e);
}

let currentSupabaseUser = null;
let supabaseRealtimeChannel = null;
let modalAuthMode = "login";

let db = loadDb();
let currentUser = localStorage.getItem(`${storeKey}:session`);
let data = currentUser && db.users[currentUser] ? db.users[currentUser].data : null;
let authMode = "login";
let timerId = null;
let audioContext = null;
let streakViewMode = "weekly";

const el = (id) => document.getElementById(id);
const authView = el("authView");
const appView = el("appView");

function loadDb() {
  try {
    return JSON.parse(localStorage.getItem(storeKey)) || { users: {} };
  } catch {
    return { users: {} };
  }
}

function saveDb() {
  const dbCopy = JSON.parse(JSON.stringify(db));
  for (const email in dbCopy.users) {
    if (dbCopy.users[email].data) {
      dbCopy.users[email].data.flashcardDecks = {};
    }
  }
  localStorage.setItem(storeKey, JSON.stringify(dbCopy));
}

function saveUser() {
  if (!currentUser) return;
  db.users[currentUser].data = data;
  saveDb();
}

function saveFlashcardDecks() {
  if (!currentUser) return;
  idb.set(`flashcard-decks:${currentUser}`, data.flashcardDecks || {}).catch(err => {
    console.error("Failed to save decks to IndexedDB:", err);
  });
}

// ----------------------------------------------------
// Supabase Cloud Todos Sync Functions
// Table Schema: id (int8), title (text), is_completed (bool), user_id (uuid)
// ----------------------------------------------------

async function fetchUserTodos() {
  if (!supabaseClient || !currentSupabaseUser) {
    if (data) data.tasks = [];
    renderTasks();
    if (typeof renderCalendarTab === "function") renderCalendarTab();
    return;
  }

  try {
    const { data: todos, error } = await supabaseClient
      .from("todos")
      .select("id, title, is_completed, user_id")
      .eq("user_id", currentSupabaseUser.id)
      .order("id", { ascending: false });

    if (error) {
      console.error("Failed to fetch todos from Supabase:", error);
      return;
    }

    const todayStr = getLocalDateString();
    if (data) {
      data.tasks = (todos || []).map((row) => {
        const isCompleted = Boolean(row.is_completed);
        const titleText = row.title || "Untitled Task";

        return {
          id: String(row.id),
          supabaseId: row.id,
          title: titleText,
          done: isCompleted,
          is_completed: isCompleted,
          tag: "Review",
          date: todayStr,
          color: "#ff6e79"
        };
      });

      saveUser();
      renderTasks();
      if (typeof renderCalendarTab === "function") renderCalendarTab();
    }
  } catch (err) {
    console.error("fetchUserTodos exception:", err);
  }
}

async function addSupabaseTodo(task) {
  if (!supabaseClient || !currentSupabaseUser) return;
  try {
    const payload = {
      title: task.title,
      is_completed: false,
      user_id: currentSupabaseUser.id
    };

    const { data: inserted, error } = await supabaseClient
      .from("todos")
      .insert([payload])
      .select();

    if (error) {
      console.error("Failed to insert task into Supabase:", error);
      return;
    }

    if (inserted && inserted.length > 0) {
      task.id = String(inserted[0].id);
      task.supabaseId = inserted[0].id;
      task.is_completed = Boolean(inserted[0].is_completed);
      task.done = task.is_completed;
      saveUser();
    }
  } catch (err) {
    console.error("addSupabaseTodo exception:", err);
  }
}

async function updateSupabaseTodo(task) {
  if (!supabaseClient || !currentSupabaseUser) return;
  const targetId = task.supabaseId || task.id;
  if (!targetId) return;

  try {
    const completedState = Boolean(task.is_completed !== undefined ? task.is_completed : task.done);
    const { error } = await supabaseClient
      .from("todos")
      .update({
        is_completed: completedState
      })
      .eq("id", targetId)
      .eq("user_id", currentSupabaseUser.id);

    if (error) {
      console.error("Failed to update task in Supabase:", error);
    }
  } catch (err) {
    console.error("updateSupabaseTodo exception:", err);
  }
}

async function deleteSupabaseTodo(task) {
  if (!supabaseClient || !currentSupabaseUser) return;
  const targetId = task.supabaseId || task.id;
  if (!targetId) return;

  try {
    const { error } = await supabaseClient
      .from("todos")
      .delete()
      .eq("id", targetId)
      .eq("user_id", currentSupabaseUser.id);

    if (error) {
      console.error("Failed to delete task from Supabase:", error);
    }
  } catch (err) {
    console.error("deleteSupabaseTodo exception:", err);
  }
}

function setupSupabaseRealtime(userId) {
  if (!supabaseClient || !userId) return;
  if (supabaseRealtimeChannel) {
    try {
      supabaseClient.removeChannel(supabaseRealtimeChannel);
    } catch (e) {}
    supabaseRealtimeChannel = null;
  }

  try {
    supabaseRealtimeChannel = supabaseClient
      .channel("public:todos")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "todos",
          filter: `user_id=eq.${userId}`
        },
        () => {
          fetchUserTodos();
        }
      )
      .subscribe();
  } catch (err) {
    console.warn("Could not subscribe to Supabase Realtime:", err);
  }
}

// ----------------------------------------------------
// Modal & Page Auth Handlers
// ----------------------------------------------------

function setModalAuthMode(mode) {
  modalAuthMode = mode;
  const loginTab = el("modalLoginTab");
  const signupTab = el("modalSignupTab");
  const nameField = el("modalNameField");
  const submitBtn = el("modalAuthSubmit");
  const msg = el("modalAuthMessage");

  if (loginTab) loginTab.classList.toggle("active", mode === "login");
  if (signupTab) signupTab.classList.toggle("active", mode === "signup");
  if (nameField) nameField.classList.toggle("hidden", mode === "login");
  if (submitBtn) submitBtn.textContent = mode === "login" ? "Log In" : "Create Account";
  if (msg) {
    msg.textContent = "";
    msg.className = "form-message";
  }
}

function setModalAuthMessage(message, type = "") {
  const node = el("modalAuthMessage");
  if (node) {
    node.textContent = message;
    node.className = `form-message ${type}`;
  }
}

function openAuthModal(initialMessage = "") {
  const modal = el("authModal");
  if (!modal) return;

  const loggedInView = el("authModalLoggedIn");
  const loggedOutView = el("authModalLoggedOut");
  const modalTitle = el("authModalTitle");

  if (currentSupabaseUser) {
    if (modalTitle) modalTitle.textContent = "My Account & Cloud Sync";
    if (loggedInView) loggedInView.classList.remove("hidden");
    if (loggedOutView) loggedOutView.classList.add("hidden");

    const emailEl = el("modalLoggedInEmail");
    if (emailEl) emailEl.textContent = currentSupabaseUser.email || currentUser || "Logged In User";

    const avatarEl = el("modalUserAvatar");
    if (avatarEl) {
      const email = currentSupabaseUser.email || currentUser || "SA";
      avatarEl.textContent = email.substring(0, 2).toUpperCase();
    }
  } else {
    if (modalTitle) modalTitle.textContent = "Log In or Sign Up";
    if (loggedInView) loggedInView.classList.add("hidden");
    if (loggedOutView) loggedOutView.classList.remove("hidden");
    setModalAuthMode("login");
    if (initialMessage) {
      setModalAuthMessage(initialMessage, "info");
    }
  }

  modal.classList.remove("hidden");
}

function closeAuthModal() {
  const modal = el("authModal");
  if (modal) modal.classList.add("hidden");
}

async function handleModalAuth(e) {
  e.preventDefault();
  if (!supabaseClient) {
    setModalAuthMessage("Supabase client is not loaded. Check connection.", "error");
    return;
  }

  const email = el("modalEmailInput").value.trim().toLowerCase();
  const password = el("modalPasswordInput").value;
  const name = el("modalNameInput") ? el("modalNameInput").value.trim() : "";
  const submitBtn = el("modalAuthSubmit");

  if (!email || !password) {
    setModalAuthMessage("Please provide both email and password.", "error");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = modalAuthMode === "login" ? "Logging in..." : "Creating account...";

  try {
    if (modalAuthMode === "signup") {
      const { data: authData, error } = await supabaseClient.auth.signUp({
        email,
        password,
        options: {
          data: { name: name || email.split("@")[0] }
        }
      });

      if (error) {
        setModalAuthMessage(error.message, "error");
        submitBtn.disabled = false;
        submitBtn.textContent = "Create Account";
        return;
      }

      if (authData.user && !authData.session) {
        setModalAuthMessage("Account created! Please check your email to confirm your account, then log in.", "ok");
        submitBtn.disabled = false;
        submitBtn.textContent = "Create Account";
        return;
      }

      setModalAuthMessage("Account created! Logging you in...", "ok");
      await login(email, authData.user);
      setTimeout(() => {
        closeAuthModal();
      }, 600);
    } else {
      const { data: authData, error } = await supabaseClient.auth.signInWithPassword({
        email,
        password
      });

      if (error) {
        setModalAuthMessage(error.message, "error");
        submitBtn.disabled = false;
        submitBtn.textContent = "Log In";
        return;
      }

      setModalAuthMessage("Logged in successfully!", "ok");
      await login(email, authData.user);
      setTimeout(() => {
        closeAuthModal();
      }, 600);
    }
  } catch (err) {
    setModalAuthMessage(err.message || "An unexpected error occurred.", "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = modalAuthMode === "login" ? "Log In" : "Create Account";
  }
}

function setAuthMode(mode) {
  authMode = mode;
  el("loginTab").classList.toggle("active", mode === "login");
  el("signupTab").classList.toggle("active", mode === "signup");
  el("nameField").classList.toggle("hidden", mode === "login");
  el("nameInput").required = mode === "signup";
  el("authSubmit").textContent = mode === "login" ? "Login" : "Create account";
  el("passwordInput").autocomplete = mode === "login" ? "current-password" : "new-password";
  setMessage("");
}

function setMessage(message, type = "") {
  const node = el("authMessage");
  if (!node) return;
  node.textContent = message;
  node.className = `form-message ${type}`;
}

async function handleAuth(event) {
  event.preventDefault();
  const name = el("nameInput").value.trim();
  const email = el("emailInput").value.trim().toLowerCase();
  const password = el("passwordInput").value;
  const submitBtn = el("authSubmit");

  if (supabaseClient) {
    submitBtn.disabled = true;
    submitBtn.textContent = authMode === "login" ? "Logging in..." : "Creating account...";
    try {
      if (authMode === "signup") {
        const { data: authData, error } = await supabaseClient.auth.signUp({
          email,
          password,
          options: { data: { name: name || email.split("@")[0] } }
        });
        if (error) {
          setMessage(error.message, "error");
          submitBtn.disabled = false;
          submitBtn.textContent = "Create account";
          return;
        }
        if (authData.user && !authData.session) {
          setMessage("Account created! Please check your email to confirm your account, then log in.", "ok");
          submitBtn.disabled = false;
          submitBtn.textContent = "Create account";
          return;
        }
        setMessage("Account created. You are logged in.", "ok");
        await login(email, authData.user);
        return;
      } else {
        const { data: authData, error } = await supabaseClient.auth.signInWithPassword({
          email,
          password
        });
        if (error) {
          setMessage(error.message, "error");
          submitBtn.disabled = false;
          submitBtn.textContent = "Login";
          return;
        }
        await login(email, authData.user);
        return;
      }
    } catch (err) {
      console.warn("Supabase auth error, falling back to local:", err);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = authMode === "login" ? "Login" : "Create account";
    }
  }

  // Fallback local storage auth
  if (authMode === "signup") {
    if (db.users[email]) {
      setMessage("An account with this email already exists.", "error");
      return;
    }
    db.users[email] = { name, password, data: defaultData() };
    saveDb();
    setMessage("Account created. You are logged in.", "ok");
    login(email);
    return;
  }

  if (!db.users[email] || db.users[email].password !== password) {
    setMessage("Email or password is incorrect.", "error");
    return;
  }
  login(email);
}

async function login(email, supabaseUser = null) {
  currentUser = email;
  currentSupabaseUser = supabaseUser;
  localStorage.setItem(`${storeKey}:session`, email);

  if (!db.users[email]) {
    db.users[email] = {
      name: supabaseUser?.user_metadata?.name || email.split("@")[0],
      data: defaultData()
    };
    saveDb();
  }

  data = normalizeData(db.users[email].data || defaultData());
  
  try {
    data.flashcardDecks = await idb.get(`flashcard-decks:${email}`) || {};
  } catch (err) {
    console.error("Failed to load decks from IndexedDB:", err);
    data.flashcardDecks = {};
  }
  
  db.users[email].data = data;
  saveDb();
  authView.classList.add("hidden");
  appView.classList.remove("hidden");

  // Update avatar & tooltips
  const initials = (email || "SA").substring(0, 2).toUpperCase();
  const userBtn = el("userButton");
  if (userBtn) {
    userBtn.textContent = initials;
    userBtn.title = `Logged in as ${email} (Click to manage account)`;
  }
  const logoutBtn = el("logoutButton");
  if (logoutBtn) {
    logoutBtn.title = `Log Out (${email})`;
  }

  renderAll();
  startTimerLoop();

  // Supabase cloud tasks fetch & realtime sync
  if (supabaseClient) {
    if (!currentSupabaseUser) {
      try {
        const { data: userData } = await supabaseClient.auth.getUser();
        if (userData?.user) {
          currentSupabaseUser = userData.user;
        }
      } catch (e) {}
    }
    if (currentSupabaseUser) {
      fetchUserTodos();
      setupSupabaseRealtime(currentSupabaseUser.id);
    }
  }
}

async function logout() {
  stopTimerLoop();
  if (supabaseClient) {
    try {
      if (supabaseRealtimeChannel) {
        supabaseClient.removeChannel(supabaseRealtimeChannel);
        supabaseRealtimeChannel = null;
      }
      await supabaseClient.auth.signOut();
    } catch (err) {
      console.warn("Supabase sign out error:", err);
    }
  }

  currentSupabaseUser = null;
  currentUser = null;
  if (data) {
    data.tasks = []; // Clear tasks when logged out
  }
  data = null;
  currentStudyDeck = null;
  currentStudyCards = [];
  currentCardIndex = 0;
  cardFlipped = false;
  activeNoteKey = null;
  activeEditorNoteId = null;
  activeEditorNoteType = null;
  if (activePdfUrl) {
    URL.revokeObjectURL(activePdfUrl);
    activePdfUrl = null;
  }
  localStorage.removeItem(`${storeKey}:session`);

  const userBtn = el("userButton");
  if (userBtn) {
    userBtn.textContent = "SA";
    userBtn.title = "Account (Not logged in)";
  }

  appView.classList.add("hidden");
  authView.classList.remove("hidden");
  setMessage("");
}

function renderAll() {
  renderDate();
  renderProgress();
  renderStats();
  renderTimer();
  renderSubjects();
  renderStreak();
  renderTasks();
  document.body.classList.toggle("focusing", data.focusMode);
  el("focusModeButton").classList.toggle("active", data.focusMode);
  el("soundButton").textContent = data.sound ? "♬" : "♩";
  el("userButton").textContent = getInitials(db.users[currentUser]?.name || currentUser);
}

function renderDate() {
  const now = new Date();
  el("dateLabel").textContent = new Intl.DateTimeFormat("en", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(now);
}

function updateTimezoneLabel() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = new Date();
    const offset = -now.getTimezoneOffset() / 60;
    const gmtOffset = `GMT${offset >= 0 ? '+' : ''}${offset}`;
    el("timezoneLabel").textContent = `${tz.replace('_', ' ')} · ${gmtOffset}`;
  } catch (e) {
    // fallback
  }
}

function renderProgress() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const end = new Date(now.getFullYear() + 1, 0, 1);
  const yearPercent = ((now - start) / (end - start)) * 100;
  const daysLeft = Math.ceil((end - now) / 86400000);
  
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayPercent = ((now - startOfDay) / 86400000) * 100;
  
  const startOfHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
  const hourPercent = ((now - startOfHour) / 3600000) * 100;
  
  const clock = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(now);

  el("yearRing").style.setProperty("--year", yearPercent);
  const dayRing = el("dayRing");
  if (dayRing) dayRing.style.setProperty("--day", dayPercent);
  const hourRing = el("hourRing");
  if (hourRing) hourRing.style.setProperty("--hour", hourPercent);

  el("yearPercent").textContent = `${Math.round(yearPercent)}%`;
  el("daysLeft").textContent = `${daysLeft} days left`;
  el("timeButton").textContent = clock;
  
  updateTimezoneLabel();
}

function renderStats() {
  const studyMinutes = Math.floor((data.studySeconds || 0) / 60);
  const studyPercent = data.studyGoal > 0 ? Math.min(100, Math.round((studyMinutes / data.studyGoal) * 100)) : 0;
  el("studyTimeText").textContent = `${Math.floor(studyMinutes / 60)}h ${studyMinutes % 60}m`;
  el("studyProgressBar").style.width = `${studyPercent}%`;
  el("studyGoalText").textContent = `Goal: ${formatGoalHours(data.studyGoal)} · ${studyPercent}%`;
  el("studyGoalInput").value = Number((data.studyGoal / 60).toFixed(2));
  const flashcardPercent = data.flashcardsGoal > 0 ? Math.min(100, Math.round(((data.flashcardsToday || 0) / data.flashcardsGoal) * 100)) : 0;
  el("flashcardsText").textContent = data.flashcardsToday || 0;
  el("flashcardsBar").style.width = `${flashcardPercent}%`;
  el("flashcardsGoalText").textContent = `Goal: ${data.flashcardsGoal} · ${flashcardPercent}%`;
  el("flashcardsGoalInput").value = data.flashcardsGoal || 50;
  const avgTime = data.flashcardTotalCount > 0 ? (data.flashcardTotalTime / data.flashcardTotalCount).toFixed(1) : 0;
  el("flashcardAvgTime").textContent = `Avg time: ${avgTime}s`;
  el("focusScoreText").textContent = data.focusScore;
  el("focusScoreBar").style.width = `${data.focusScore}%`;
  
  const { currentStreak } = getStreakData();
  data.streak = currentStreak;
  data.bestStreak = Math.max(data.bestStreak || 0, currentStreak);
  
  el("streakText").textContent = data.streak;
  el("topStreak").textContent = data.streak;
  el("bestStreakText").textContent = `Best: ${data.bestStreak} days`;
}

function getTimerDuration(mode) {
  if (mode === "focus") {
    return (data.timerFocusDurationMin || 25) * 60;
  } else {
    return (data.timerBreakDurationMin || 5) * 60;
  }
}

function renderTimer() {
  document.querySelectorAll(".timer-mode").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === data.timerMode);
  });
  const max = getTimerDuration(data.timerMode);
  const elapsed = max - data.timerRemaining;
  const progress = Math.max(0, Math.min(100, Math.round((elapsed / max) * 100)));
  el("timerRing").style.setProperty("--timer", progress);
  el("timerText").textContent = formatTime(data.timerRemaining);
  el("timerState").textContent = data.timerRunning ? modeLabels[data.timerMode] : "Paused";
  el("playTimer").textContent = data.timerRunning ? "Ⅱ" : "▶";

  const target = data.timerTargetSessions || 4;
  const today = data.sessionsToday || 0;
  const totalDots = Math.max(target, today);

  el("sessionLabel").innerHTML = `Daily Goal: <strong style="font-size: 1.15em; color: var(--purple);">${today}</strong> of <strong>${target}</strong> completed`;

  const dots = el("sessionDots");
  dots.innerHTML = "";
  for (let i = 1; i <= totalDots; i += 1) {
    const dot = document.createElement("span");
    dot.className = i <= today ? "active" : "";
    dots.append(dot);
  }

  // Sync settings inputs if the user is not actively typing in them
  if (document.activeElement !== el("focusMinInput")) {
    el("focusMinInput").value = data.timerFocusDurationMin || 25;
  }
  if (document.activeElement !== el("breakMinInput")) {
    el("breakMinInput").value = data.timerBreakDurationMin || 5;
  }
  if (document.activeElement !== el("targetSessionsInput")) {
    el("targetSessionsInput").value = data.timerTargetSessions || 4;
  }
}

function renderSubjects() {
  const list = el("subjectList");
  list.innerHTML = "";
  data.subjects.forEach((subject, index) => {
    const row = document.createElement("div");
    row.className = "coverage-row";
    row.innerHTML = `
      <label>${escapeHtml(subject.name)}</label>
      <input type="range" min="0" max="100" value="${subject.value}" data-subject="${index}" />
      <span>${subject.value}%</span>
    `;
    row.querySelector("input").style.accentColor = colorValue(subject.color);
    list.append(row);
  });
}

function renderStreak() {
  checkDayChange();
  const weekGrid = el("weekGrid");
  weekGrid.innerHTML = "";
  
  const { dateToSegmentLength, currentStreak } = getStreakData();
  data.streak = currentStreak;
  data.bestStreak = Math.max(data.bestStreak || 0, currentStreak);
  
  const now = new Date();
  const todayStr = getLocalDateString(now);
  
  if (streakViewMode === "weekly") {
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(now.getFullYear(), now.getMonth(), diff);
    monday.setHours(0, 0, 0, 0);
    
    const weekdayLabels = ["M", "T", "W", "T", "F", "S", "S"];
    
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const dateStr = getLocalDateString(d);
      
      const cell = document.createElement("div");
      cell.className = "streak-day";
      
      const isFuture = dateStr > todayStr;
      const studyTime = data.dailyStudy[dateStr] || 0;
      
      if (isFuture) {
        cell.classList.add("future");
        cell.innerHTML = `<span>${weekdayLabels[i]}</span>`;
      } else if (studyTime > 0) {
        const segLen = dateToSegmentLength[dateStr] || 0;
        if (segLen > 3) {
          cell.classList.add("streak-fire");
          cell.innerHTML = `<span>${weekdayLabels[i]}</span><span class="fire-icon">🔥</span>`;
        } else {
          cell.classList.add("study-no-streak");
          cell.innerHTML = `<span>${weekdayLabels[i]}</span>`;
        }
      } else {
        if (dateStr === todayStr) {
          cell.classList.add("future");
          cell.innerHTML = `<span>${weekdayLabels[i]}</span>`;
        } else {
          cell.classList.add("past-no-study");
          cell.innerHTML = `<span>${weekdayLabels[i]}</span>`;
        }
      }
      weekGrid.append(cell);
    }
    
    let activeDaysCount = 0;
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const dateStr = getLocalDateString(d);
      if ((data.dailyStudy[dateStr] || 0) > 0) {
        activeDaysCount++;
      }
    }
    el("metricDays").textContent = activeDaysCount;
  } else {
    // Monthly view
    const year = now.getFullYear();
    const month = now.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    
    let startDay = firstDay.getDay(); // 0 Sunday, 1 Monday, ...
    startDay = startDay === 0 ? 6 : startDay - 1; // convert to Mon=0, Sun=6
    
    // Spacer cells
    for (let i = 0; i < startDay; i++) {
      const spacer = document.createElement("div");
      spacer.className = "streak-day spacer";
      weekGrid.append(spacer);
    }
    
    // Day cells
    const totalDays = lastDay.getDate();
    let activeDaysCount = 0;
    
    for (let dayNum = 1; dayNum <= totalDays; dayNum++) {
      const d = new Date(year, month, dayNum);
      const dateStr = getLocalDateString(d);
      
      const cell = document.createElement("div");
      cell.className = "streak-day";
      
      const isFuture = dateStr > todayStr;
      const studyTime = data.dailyStudy[dateStr] || 0;
      if (studyTime > 0) {
        activeDaysCount++;
      }
      
      if (isFuture) {
        cell.classList.add("future");
        cell.innerHTML = `<span>${dayNum}</span>`;
      } else if (studyTime > 0) {
        const segLen = dateToSegmentLength[dateStr] || 0;
        if (segLen > 3) {
          cell.classList.add("streak-fire");
          cell.innerHTML = `<span>${dayNum}</span><span class="fire-icon">🔥</span>`;
        } else {
          cell.classList.add("study-no-streak");
          cell.innerHTML = `<span>${dayNum}</span>`;
        }
      } else {
        if (dateStr === todayStr) {
          cell.classList.add("future");
          cell.innerHTML = `<span>${dayNum}</span>`;
        } else {
          cell.classList.add("past-no-study");
          cell.innerHTML = `<span>${dayNum}</span>`;
        }
      }
      weekGrid.append(cell);
    }
    el("metricDays").textContent = activeDaysCount;
  }
  
  const totalSecondsAllTime = Object.values(data.dailyStudy).reduce((acc, val) => acc + (val || 0), 0);
  el("metricHours").textContent = `${Math.floor(totalSecondsAllTime / 3600)}h`;
  
  const totalSessionsAllTime = Object.values(data.dailySessions).reduce((acc, val) => acc + (val || 0), 0);
  el("metricSessions").textContent = totalSessionsAllTime;
}

function renderTasks() {
  const list = el("taskList");
  if (!list) return;
  list.innerHTML = "";

  if (!currentSupabaseUser && (!currentUser || !data)) {
    list.innerHTML = `
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 20px 12px; text-align: center; color: var(--muted); font-size: 11px;">
        <span>Please log in to view and sync your study tasks with the cloud.</span>
        <button type="button" id="promptLoginTasksBtn" class="primary-action" style="padding: 6px 14px; font-size: 11px; margin-top: 4px; border-radius: 6px; cursor: pointer;">Log In / Sign Up</button>
      </div>
    `;
    const promptBtn = el("promptLoginTasksBtn");
    if (promptBtn) {
      promptBtn.addEventListener("click", () => openAuthModal());
    }
    return;
  }

  if (!data) return;
  const todayStr = getLocalDateString();
  const tasks = data.tasks || [];
  let renderedCount = 0;

  tasks.forEach((task, index) => {
    const taskDate = task.date || todayStr;
    if (taskDate !== todayStr) return;
    renderedCount++;

    const isCompleted = task.is_completed !== undefined ? Boolean(task.is_completed) : Boolean(task.done);

    const row = document.createElement("div");
    row.className = `task ${isCompleted ? "completed" : ""}`;
    row.style.borderLeft = `3px solid ${task.color || "#ff6e79"}`;
    row.style.paddingLeft = "8px";
    row.innerHTML = `
      <input type="checkbox" ${isCompleted ? "checked" : ""} data-task="${index}" />
      <span class="task-title">${escapeHtml(task.title)}</span>
      <span class="tag ${escapeHtml(task.tag || "Review")}">${escapeHtml(task.tag || "Review")}</span>
      <button class="delete-task" type="button" data-delete-task="${index}" title="Delete task">×</button>
    `;
    list.append(row);
  });

  if (renderedCount === 0) {
    const emptyRow = document.createElement("div");
    emptyRow.style.cssText = "text-align: center; color: var(--muted); font-size: 11px; padding: 12px 0;";
    emptyRow.textContent = "No tasks for today. Add one below!";
    list.append(emptyRow);
  }

  const taskColorSelect = el("taskColorInput");
  if (taskColorSelect && data.colorLabels) {
    const prevVal = taskColorSelect.value;
    taskColorSelect.innerHTML = `
      <option value="#ff6e79">${escapeHtml(data.colorLabels["#ff6e79"] || "Study Tasks")}</option>
      <option value="#7c67ff">${escapeHtml(data.colorLabels["#7c67ff"] || "Schedules")}</option>
      <option value="#58ddd2">${escapeHtml(data.colorLabels["#58ddd2"] || "Focus Sessions")}</option>
      <option value="#ffb329">${escapeHtml(data.colorLabels["#ffb329"] || "Other")}</option>
    `;
    if (prevVal) taskColorSelect.value = prevVal;
  }
}

function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatGoalHours(totalMinutes) {
  const hours = totalMinutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}h`;
}

function parseMarkdown(text) {
  if (!text) return "";
  let html = escapeHtml(text);
  
  // Headers: # Header
  html = html.replace(/^### (.*?)$/gm, '<h5 style="font-size:14px; font-weight:700; margin:12px 0 6px; color:var(--text);">$1</h5>');
  html = html.replace(/^## (.*?)$/gm, '<h4 style="font-size:16px; font-weight:700; margin:16px 0 8px; color:var(--text);">$1</h4>');
  html = html.replace(/^# (.*?)$/gm, '<h3 style="font-size:18px; font-weight:700; margin:20px 0 10px; color:var(--text);">$1</h3>');

  // Bold: **text**
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  
  // Italics: *text*
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  
  // Inline code: `code`
  html = html.replace(/`(.*?)`/g, '<code style="background:var(--panel); padding:2px 4px; border-radius:4px; font-family:monospace; color:var(--purple); font-size:11px;">$1</code>');

  // Lists: - item
  html = html.replace(/^- (.*?)$/gm, '<li style="margin-left:20px; list-style-type:disc; margin-bottom:4px;">$1</li>');

  // Multi-line spacing
  html = html.replace(/\n\n/g, '<div style="height:12px;"></div>');
  html = html.replace(/\n/g, '<br/>');

  return html;
}

function syncTimerOnWake() {
  if (!data || !data.timerRunning || !data.timerLastTick) return;
  const now = Date.now();
  const elapsedMs = now - data.timerLastTick;
  const elapsedSec = Math.floor(elapsedMs / 1000);
  if (elapsedSec > 0) {
    checkDayChange();
    data.timerRemaining = Math.max(0, data.timerRemaining - elapsedSec);
    if (data.timerMode === "focus") {
      data.studySeconds = (data.studySeconds || 0) + elapsedSec;
      const todayStr = getLocalDateString();
      data.dailyStudy = data.dailyStudy || {};
      data.dailyStudy[todayStr] = data.studySeconds;
    }
    data.timerLastTick += elapsedSec * 1000;
    if (data.timerRemaining <= 0) {
      completeTimerSession();
    }
    saveUser();
    renderAll();
  }
}

function startTimerLoop() {
  stopTimerLoop();
  if (data) {
    data.timerLastTick = Date.now();
    saveUser();
  }
  timerId = window.setInterval(() => {
    renderProgress();
    if (!data || !data.timerRunning) return;
    
    const now = Date.now();
    const elapsedMs = now - data.timerLastTick;
    const elapsedSec = Math.floor(elapsedMs / 1000);
    
    if (elapsedSec > 0) {
      checkDayChange();
      data.timerRemaining = Math.max(0, data.timerRemaining - elapsedSec);
      if (data.timerMode === "focus") {
        data.studySeconds = (data.studySeconds || 0) + elapsedSec;
        const todayStr = getLocalDateString();
        data.dailyStudy = data.dailyStudy || {};
        data.dailyStudy[todayStr] = data.studySeconds;
      }
      
      data.timerLastTick += elapsedSec * 1000;
      
      if (data.timerRemaining <= 0) {
        completeTimerSession();
      }
      renderStats();
      renderStreak();
      renderTimer();
      saveUser();
    }
  }, 1000);
}

function stopTimerLoop() {
  if (timerId) {
    window.clearInterval(timerId);
    timerId = null;
  }
}

function completeTimerSession() {
  playTone("complete");
  if (data.timerMode === "focus") {
    data.timerSession = (data.timerSession || 0) + 1;
    data.sessionsToday = (data.sessionsToday || 0) + 1;
    const todayStr = getLocalDateString();
    data.dailySessions = data.dailySessions || {};
    data.dailySessions[todayStr] = data.sessionsToday;

    const { currentStreak } = getStreakData();
    data.streak = currentStreak;
    data.bestStreak = Math.max(data.bestStreak || 0, currentStreak);
    
    data.timerMode = "break";
  } else {
    data.timerMode = "focus";
  }
  data.timerRemaining = getTimerDuration(data.timerMode);
  data.timerRunning = false;
  renderStats();
  renderTimer();
}

function playTone(kind) {
  if (!data.sound) return;
  audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
  const base = kind === "complete" ? 660 : 440;
  [base, base * 1.25].forEach((frequency, index) => {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime + index * 0.08);
    gain.gain.exponentialRampToValueAtTime(0.22, audioContext.currentTime + index * 0.08 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + index * 0.08 + 0.22);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(audioContext.currentTime + index * 0.08);
    oscillator.stop(audioContext.currentTime + index * 0.08 + 0.24);
  });
}

function colorValue(name) {
  return {
    purple: "#7c67ff",
    mint: "#58ddd2",
    amber: "#ffb329",
    red: "#ff6e79"
  }[name] || "#7c67ff";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

function checkDayChange() {
  if (!data) return;
  const todayStr = getLocalDateString();
  if (!data.lastActiveDate) {
    data.lastActiveDate = todayStr;
    data.dailyStudy = data.dailyStudy || {};
    data.dailyStudy[todayStr] = data.studySeconds || 0;
    data.dailySessions = data.dailySessions || {};
    data.dailySessions[todayStr] = data.sessionsToday || 0;
    data.dailyFlashcards = data.dailyFlashcards || {};
    data.dailyFlashcards[todayStr] = data.flashcardsToday || 0;
    saveUser();
    return;
  }
  if (data.lastActiveDate !== todayStr) {
    data.dailyStudy = data.dailyStudy || {};
    data.dailyStudy[data.lastActiveDate] = data.studySeconds || 0;
    data.dailySessions = data.dailySessions || {};
    data.dailySessions[data.lastActiveDate] = data.sessionsToday || 0;
    data.dailyFlashcards = data.dailyFlashcards || {};
    data.dailyFlashcards[data.lastActiveDate] = data.flashcardsToday || 0;

    data.studySeconds = 0;
    data.sessionsToday = 0;
    data.flashcardsToday = 0;
    data.lastActiveDate = todayStr;
    data.dailyStudy[todayStr] = 0;
    data.dailySessions[todayStr] = 0;
    data.dailyFlashcards[todayStr] = 0;
    saveUser();
  }
}

function getStreakData() {
  const dailyStudy = data.dailyStudy || {};
  const studiedDates = Object.keys(dailyStudy).filter(dateStr => dailyStudy[dateStr] > 0);
  const dates = studiedDates.map(d => new Date(d + 'T00:00:00'));
  dates.sort((a, b) => a - b);
  
  const segments = [];
  let currentSegment = [];
  
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    if (currentSegment.length === 0) {
      currentSegment.push(d);
    } else {
      const lastDate = currentSegment[currentSegment.length - 1];
      const diffTime = d - lastDate;
      const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
      if (diffDays === 1) {
        currentSegment.push(d);
      } else {
        segments.push(currentSegment);
        currentSegment = [d];
      }
    }
  }
  if (currentSegment.length > 0) {
    segments.push(currentSegment);
  }
  
  const dateToSegmentLength = {};
  segments.forEach(seg => {
    const len = seg.length;
    seg.forEach(d => {
      dateToSegmentLength[getLocalDateString(d)] = len;
    });
  });
  
  const todayStr = getLocalDateString();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = getLocalDateString(yesterday);
  
  let currentStreakVal = 0;
  let activeSegment = null;
  for (const seg of segments) {
    const segStr = seg.map(d => getLocalDateString(d));
    if (segStr.includes(todayStr) || segStr.includes(yesterdayStr)) {
      activeSegment = seg;
    }
  }
  
  if (activeSegment) {
    currentStreakVal = activeSegment.length;
  }
  
  const finalStreak = currentStreakVal > 3 ? currentStreakVal : 0;
  
  return {
    dateToSegmentLength,
    currentStreak: finalStreak,
    actualStreakLength: currentStreakVal
  };
}

function normalizeData(savedData) {
  const defaults = defaultData();
  const normalized = { ...defaults, ...savedData };
  
  normalized.dailyStudy = normalized.dailyStudy || {};
  normalized.dailySessions = normalized.dailySessions || {};
  normalized.sessionsToday = typeof normalized.sessionsToday === 'number' ? normalized.sessionsToday : 0;
  normalized.lastActiveDate = normalized.lastActiveDate || "";
  normalized.flashcardDecks = normalized.flashcardDecks || {};
  
  normalized.flashcardsToday = typeof normalized.flashcardsToday === 'number' ? normalized.flashcardsToday : 0;
  normalized.flashcardsGoal = typeof normalized.flashcardsGoal === 'number' ? normalized.flashcardsGoal : 50;
  normalized.flashcardRatings = normalized.flashcardRatings || { easy: 0, good: 0, hard: 0 };
  normalized.flashcardTotalTime = typeof normalized.flashcardTotalTime === 'number' ? normalized.flashcardTotalTime : 0;
  normalized.flashcardTotalCount = typeof normalized.flashcardTotalCount === 'number' ? normalized.flashcardTotalCount : 0;
  normalized.dailyFlashcards = normalized.dailyFlashcards || {};
  
  if (typeof normalized.studySeconds !== "number") {
    normalized.studySeconds = Math.max(0, Number(savedData.studyMinutes || 0) * 60);
  }
  normalized.studyGoal = Math.max(15, Number(normalized.studyGoal) || defaults.studyGoal);
  normalized.timerRemaining = Math.max(0, Number(normalized.timerRemaining) || defaults.timerRemaining);
  normalized.timerSession = Math.max(0, Number(normalized.timerSession) || 0);
  normalized.timerFocusDurationMin = Number(normalized.timerFocusDurationMin) || 25;
  normalized.timerBreakDurationMin = Number(normalized.timerBreakDurationMin) || 5;
  normalized.timerTargetSessions = Number(normalized.timerTargetSessions) || 4;
  normalized.notesList = Array.isArray(normalized.notesList) ? normalized.notesList : [];
  normalized.unlinkedNotes = Array.isArray(normalized.unlinkedNotes) ? normalized.unlinkedNotes : [];
  normalized.calendarEvents = Array.isArray(normalized.calendarEvents) ? normalized.calendarEvents : [];
  normalized.tasks = Array.isArray(normalized.tasks) ? normalized.tasks : [
    { title: "Review lymphoma slides", tag: "Path", done: true },
    { title: "Anki - cardiac drugs", tag: "Pharm", done: true },
    { title: "MCQs - renal pathology", tag: "Path", done: false },
    { title: "Notes - GI bleeding", tag: "Path", done: false },
    { title: "Past paper 2023 block 3", tag: "Exam", done: false }
  ];

  // Assure colorLabels exist
  normalized.colorLabels = normalized.colorLabels || {
    "#ff6e79": "Study Tasks",
    "#7c67ff": "Schedules",
    "#58ddd2": "Focus Sessions",
    "#ffb329": "Other"
  };

  // Assure all tasks have unique IDs
  normalized.tasks.forEach((t, i) => {
    if (!t.id) {
      t.id = "task-" + i + "-" + Date.now();
    }
  });

  normalized.isHost = currentUser === "host@example.com" || !!normalized.isHost;
  normalized.week = Array.isArray(normalized.week) ? normalized.week.slice(0, 7) : defaults.week;
  while (normalized.week.length < 7) normalized.week.push(false);
  return normalized;
}

function getInitials(nameOrEmail) {
  const name = String(nameOrEmail || "SA").trim();
  const parts = name.includes("@") ? [name.split("@")[0]] : name.split(/\s+/);
  return parts
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("") || "SA";
}

function isZstd(bytes) {
  return bytes && bytes.length >= 4 &&
         bytes[0] === 0x28 &&
         bytes[1] === 0xB5 &&
         bytes[2] === 0x2F &&
         bytes[3] === 0xFD;
}

function parseAnkiMediaProtobuf(bytes) {
  const mediaMap = {};
  let pos = 0;
  let entryIndex = 0;
  
  while (pos < bytes.length) {
    if (pos >= bytes.length) break;
    const tagByte = bytes[pos++];
    const field = tagByte >> 3;
    const wireType = tagByte & 7;
    
    if (field === 1 && wireType === 2) {
      let entryLen = 0;
      let shift = 0;
      while (true) {
        if (pos >= bytes.length) break;
        const b = bytes[pos++];
        entryLen |= (b & 0x7f) << shift;
        shift += 7;
        if (!(b & 0x80)) break;
      }
      
      const entryEnd = pos + entryLen;
      let filename = "";
      
      while (pos < entryEnd) {
        if (pos >= bytes.length) break;
        const innerTag = bytes[pos++];
        const innerField = innerTag >> 3;
        const innerWire = innerTag & 7;
        
        if (innerField === 1 && innerWire === 2) {
          let flen = 0;
          let fshift = 0;
          while (true) {
            if (pos >= bytes.length) break;
            const b = bytes[pos++];
            flen |= (b & 0x7f) << fshift;
            fshift += 7;
            if (!(b & 0x80)) break;
          }
          const fileBytes = bytes.subarray(pos, pos + flen);
          filename = new TextDecoder().decode(fileBytes);
          pos += flen;
        } else {
          if (innerWire === 0) {
            while (pos < bytes.length && (bytes[pos] & 0x80)) {
              pos++;
            }
            pos++;
          } else if (innerWire === 2) {
            let skipLen = 0;
            let sshift = 0;
            while (true) {
              if (pos >= bytes.length) break;
              const b = bytes[pos++];
              skipLen |= (b & 0x7f) << sshift;
              sshift += 7;
              if (!(b & 0x80)) break;
            }
            pos += skipLen;
          } else {
            pos++;
          }
        }
      }
      
      if (filename) {
        mediaMap[String(entryIndex)] = filename;
      }
      entryIndex++;
    } else {
      if (wireType === 0) {
        while (pos < bytes.length && (bytes[pos] & 0x80)) {
          pos++;
        }
        pos++;
      } else if (wireType === 2) {
        let skipLen = 0;
        let sshift = 0;
        while (true) {
          if (pos >= bytes.length) break;
          const b = bytes[pos++];
          skipLen |= (b & 0x7f) << sshift;
          sshift += 7;
          if (!(b & 0x80)) break;
        }
        pos += skipLen;
      } else {
        pos++;
      }
    }
  }
  
  return mediaMap;
}

function uint8ArrayToBase64(bytes) {
  let binary = "";
  const len = bytes.byteLength;
  const chunk = 8192;
  for (let i = 0; i < len; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function isImageOcclusionCard(card) {
  if (!card) return false;
  const rectRegex = /\{\{(c\d+)::(?:image-occlusion:)?rect:([^}]+)\}\}/g;
  return rectRegex.test(card.front || "") || rectRegex.test(card.back || "");
}

function shouldCardBeLarge(card) {
  if (!card) return false;
  if ((card.front || "").includes("<img") || (card.back || "").includes("<img")) {
    return true;
  }
  const tempDiv = document.createElement("div");
  tempDiv.innerHTML = (card.front || "") + " " + (card.back || "");
  const textLength = tempDiv.textContent.trim().length;
  return textLength > 200;
}

function renderImageOcclusionHTML(card, isBack) {
  if (!card) return "";
  
  if (typeof card === "string") {
    return card;
  }
  
  const front = card.front || "";
  const back = card.back || "";
  const ord = card.ord || 0;
  
  const rectRegex = /\{\{(c\d+)::(?:image-occlusion:)?rect:([^}]+)\}\}/g;
  rectRegex.lastIndex = 0;
  
  const rects = [];
  let match;
  const searchHtml = front + " " + back;
  while ((match = rectRegex.exec(searchHtml)) !== null) {
    const cloze = match[1];
    const paramsStr = match[2];
    const params = {};
    paramsStr.split(":").forEach(param => {
      const [key, val] = param.split("=");
      if (key && val) {
        params[key] = parseFloat(val);
      }
    });
    rects.push({ cloze, ...params });
  }
  
  let cleanFront = front.replace(/\{\{(c\d+)::(?:image-occlusion:)?rect:[^}]+\}\}/g, "");
  let cleanBack = back.replace(/\{\{(c\d+)::(?:image-occlusion:)?rect:[^}]+\}\}/g, "");
  
  if (rects.length === 0) {
    return isBack ? cleanBack : cleanFront;
  }
  
  const parser = new DOMParser();
  const docBack = parser.parseFromString(cleanBack, "text/html");
  const docFront = parser.parseFromString(cleanFront, "text/html");
  
  const img = docBack.querySelector("img") || docFront.querySelector("img");
  if (!img) {
    return isBack ? cleanBack : cleanFront;
  }
  
  const container = document.createElement("div");
  container.className = "image-occlusion-container";
  container.style.position = "relative";
  container.style.display = "inline-block";
  container.style.maxWidth = "100%";
  
  const imgClone = img.cloneNode(true);
  imgClone.style.display = "block";
  imgClone.style.maxWidth = "100%";
  imgClone.style.height = "auto";
  container.appendChild(imgClone);
  
  const activeCloze = `c${ord + 1}`;
  
  rects.forEach(rect => {
    const rectDiv = document.createElement("div");
    rectDiv.className = "occlusion-rect";
    rectDiv.style.position = "absolute";
    rectDiv.style.left = `${rect.left * 100}%`;
    rectDiv.style.top = `${rect.top * 100}%`;
    rectDiv.style.width = `${rect.width * 100}%`;
    rectDiv.style.height = `${rect.height * 100}%`;
    rectDiv.style.boxSizing = "border-box";
    
    const isActive = rect.cloze === activeCloze;
    if (isActive) {
      if (isBack) {
        rectDiv.style.display = "none";
      } else {
        rectDiv.style.background = "#ef4444";
        rectDiv.style.border = "2px solid #dc2626";
        rectDiv.style.boxShadow = "0 0 8px rgba(239, 68, 68, 0.5)";
      }
    } else {
      rectDiv.style.background = "#f59e0b";
      rectDiv.style.border = "1px solid #d97706";
    }
    
    container.appendChild(rectDiv);
  });
  
  if (isBack) {
    const imgInDocBack = docBack.querySelector("img");
    if (imgInDocBack) {
      imgInDocBack.remove();
    }
    const extraHtml = docBack.body.innerHTML.trim();
    if (extraHtml) {
      const wrapper = document.createElement("div");
      wrapper.appendChild(container);
      
      const extraDiv = document.createElement("div");
      extraDiv.className = "occlusion-extra-info";
      extraDiv.innerHTML = extraHtml;
      wrapper.appendChild(extraDiv);
      
      return wrapper.innerHTML;
    }
  } else {
    const imgInDocFront = docFront.querySelector("img");
    if (imgInDocFront) {
      imgInDocFront.remove();
    }
    const extraHtml = docFront.body.innerHTML.replace(/(?:<br\s*\/?>)+/g, " ").trim();
    if (extraHtml && extraHtml !== "") {
      const wrapper = document.createElement("div");
      wrapper.appendChild(container);
      
      const extraDiv = document.createElement("div");
      extraDiv.className = "occlusion-extra-info";
      extraDiv.innerHTML = extraHtml;
      wrapper.appendChild(extraDiv);
      
      return wrapper.innerHTML;
    }
  }
  
  return container.outerHTML;
}


function buildDeckTree(deckNames, decksData) {
  const root = { name: "Root", fullName: "", children: {}, cardsCount: 0 };
  
  deckNames.forEach(fullName => {
    const parts = fullName.split("::");
    let current = root;
    
    parts.forEach((part, index) => {
      if (!current.children[part]) {
        const subName = parts.slice(0, index + 1).join("::");
        current.children[part] = {
          name: part,
          fullName: subName,
          children: {},
          cardsCount: 0
        };
      }
      current = current.children[part];
    });
  });
  
  function calculateCounts(node) {
    let count = (decksData[node.fullName] || []).length;
    for (const childName in node.children) {
      count += calculateCounts(node.children[childName]);
    }
    node.cardsCount = count;
    return count;
  }
  calculateCounts(root);
  
  return root;
}

function deleteDeckAndSubdecks(prefix) {
  if (data.flashcardDecks) {
    for (const name in data.flashcardDecks) {
      if (name === prefix || name.startsWith(prefix + "::")) {
        delete data.flashcardDecks[name];
      }
    }
    saveFlashcardDecks();
    saveUser();
  }
  if (currentStudyDeck && (currentStudyDeck === prefix || currentStudyDeck.startsWith(prefix + "::"))) {
    currentStudyDeck = null;
    currentStudyCards = [];
    currentCardIndex = 0;
    cardFlipped = false;
    cardShownTime = null;
  }
  renderFlashcardsTab();
}

function cleanAnkiText(text, imagesMap = {}) {
  if (!text) return "";
  
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "text/html");
  
  const imgs = doc.querySelectorAll("img");
  imgs.forEach(img => {
    const src = img.getAttribute("src");
    if (src) {
      const decoded = decodeURIComponent(src);
      if (imagesMap[src]) {
        img.setAttribute("src", imagesMap[src]);
      } else if (imagesMap[decoded]) {
        img.setAttribute("src", imagesMap[decoded]);
      }
    }
  });
  
  const unsafeTags = ["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META"];
  const cleanNode = (node) => {
    const children = Array.from(node.childNodes);
    children.forEach(child => {
      if (child.nodeType === Node.ELEMENT_NODE) {
        if (unsafeTags.includes(child.tagName)) {
          child.remove();
        } else {
          const attrs = Array.from(child.attributes);
          attrs.forEach(attr => {
            if (attr.name.toLowerCase().startsWith("on")) {
              child.removeAttribute(attr.name);
            }
          });
          cleanNode(child);
        }
      }
    });
  };
  cleanNode(doc.body);
  
  return doc.body.innerHTML;
}

async function handleAnkiImport(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = async function(e) {
    const arrayBuffer = e.target.result;
    try {
      el("studyViewContainer").innerHTML = `
        <div class="empty-state">
          <div class="icon">⏳</div>
          <h3>Processing deck...</h3>
          <p>Extracting Anki package files and media. Please wait.</p>
        </div>
      `;
      
      const zip = await JSZip.loadAsync(arrayBuffer);
      let dbFile = zip.file("collection.anki21b");
      if (!dbFile) {
        dbFile = zip.file("collection.anki21");
      }
      if (!dbFile) {
        dbFile = zip.file("collection.anki2");
      }
      if (!dbFile) {
        throw new Error("Invalid .apkg file: collection database not found.");
      }
      
      const dbDataRaw = await dbFile.async("uint8array");
      let dbData = dbDataRaw;
      if (isZstd(dbDataRaw)) {
        if (typeof fzstd === "undefined") {
          throw new Error("Zstandard decompression library (fzstd) is not loaded.");
        }
        dbData = fzstd.decompress(dbDataRaw);
      }
      
      const imagesMap = {};
      const mediaFile = zip.file("media");
      if (mediaFile) {
        let mediaBytes = await mediaFile.async("uint8array");
        if (isZstd(mediaBytes)) {
          if (typeof fzstd === "undefined") {
            throw new Error("Zstandard decompression library (fzstd) is not loaded.");
          }
          mediaBytes = fzstd.decompress(mediaBytes);
        }
        
        let mediaMap = {};
        if (mediaBytes && mediaBytes.length > 0) {
          if (mediaBytes[0] === 0x7b) {
            const mediaJsonText = new TextDecoder().decode(mediaBytes);
            try {
              mediaMap = JSON.parse(mediaJsonText);
            } catch (jsonErr) {
              console.error("Failed to parse Anki media JSON:", jsonErr, mediaJsonText);
              throw new Error("Invalid Anki media JSON: " + jsonErr.message + ". Content starts with: " + mediaJsonText.slice(0, 150));
            }
          } else {
            try {
              mediaMap = parseAnkiMediaProtobuf(mediaBytes);
            } catch (protoErr) {
              console.error("Failed to parse Anki media Protobuf:", protoErr);
              throw new Error("Invalid Anki media Protobuf: " + protoErr.message);
            }
          }
        }
        
        for (const zipKey in mediaMap) {
          const filename = mediaMap[zipKey];
          if (/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(filename)) {
            const imgFile = zip.file(zipKey);
            if (imgFile) {
              let fileBytes = await imgFile.async("uint8array");
              if (isZstd(fileBytes)) {
                if (typeof fzstd === "undefined") {
                  throw new Error("Zstandard decompression library (fzstd) is not loaded.");
                }
                fileBytes = fzstd.decompress(fileBytes);
              }
              const ext = filename.split('.').pop().toLowerCase();
              let mime = "image/png";
              if (ext === "jpg" || ext === "jpeg") mime = "image/jpeg";
              else if (ext === "gif") mime = "image/gif";
              else if (ext === "webp") mime = "image/webp";
              else if (ext === "svg") mime = "image/svg+xml";
              
              imagesMap[filename] = `data:${mime};base64,${uint8ArrayToBase64(fileBytes)}`;
            }
          }
        }
      }
      
      const SQL = await initSqlJs({
        locateFile: filename => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${filename}`
      });
      
      const db = new SQL.Database(dbData);
      const deckIdToName = {};
      
      // Check if 'decks' table exists (Schema version 15/16+ / Anki 2.1.50+)
      const tableCheck = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='decks'");
      if (tableCheck.length > 0 && tableCheck[0].values.length > 0) {
        const decksQuery = db.exec("SELECT id, name FROM decks");
        if (decksQuery.length > 0 && decksQuery[0].values) {
          decksQuery[0].values.forEach(row => {
            const id = row[0];
            const name = row[1];
            deckIdToName[id] = name.replace(/\x1f/g, "::");
          });
        }
      } else {
        // Fall back to legacy 'col.decks' JSON column
        const colDecks = db.exec("SELECT decks FROM col");
        if (colDecks.length === 0) {
          throw new Error("Could not read decks metadata from collection.");
        }
        const rawDecks = colDecks[0].values[0][0];
        let decksJson = {};
        if (rawDecks && rawDecks.trim() !== "") {
          try {
            decksJson = JSON.parse(rawDecks);
          } catch (jsonErr) {
            console.error("Failed to parse Anki decks JSON:", jsonErr, rawDecks);
            throw new Error("Invalid Anki decks JSON: " + jsonErr.message + ". Content starts with: " + String(rawDecks).slice(0, 150));
          }
        }
        for (const id in decksJson) {
          deckIdToName[id] = decksJson[id].name;
        }
      }
      
      const cardsQuery = db.exec("SELECT c.did, n.flds, c.ord FROM cards c JOIN notes n ON c.nid = n.id");
      if (cardsQuery.length === 0) {
        throw new Error("No cards found in the Anki database.");
      }
      
      const rows = cardsQuery[0].values;
      const importedDecks = {};
      
      rows.forEach(row => {
        const deckId = row[0];
        const fldsStr = row[1];
        const ord = row[2];
        
        const deckName = deckIdToName[deckId] || "Default Deck";
        const fields = fldsStr.split("\u001f");
        
        const front = fields[0] || "";
        const back = fields[1] || "";
        
        const cleanFront = cleanAnkiText(front, imagesMap);
        const cleanBack = cleanAnkiText(back, imagesMap);
        
        if (cleanFront && cleanBack) {
          if (!importedDecks[deckName]) {
            importedDecks[deckName] = [];
          }
          importedDecks[deckName].push({
            front: cleanFront,
            back: cleanBack,
            ord: ord
          });
        }
      });
      
      data.flashcardDecks = data.flashcardDecks || {};
      for (const deckName in importedDecks) {
        data.flashcardDecks[deckName] = importedDecks[deckName];
      }
      saveFlashcardDecks();
      saveUser();
      renderFlashcardsTab();
    } catch (err) {
      console.error(err);
      el("studyViewContainer").innerHTML = `
        <div class="empty-state">
          <div class="icon">❌</div>
          <h3>Import failed</h3>
          <p>${escapeHtml(err.message || "An error occurred while parsing the .apkg file.")}</p>
        </div>
      `;
    } finally {
      event.target.value = "";
    }
  };
  reader.readAsArrayBuffer(file);
}

function updateSidebarUI() {
  const layout = document.querySelector(".flashcards-layout");
  if (!layout) return;
  
  const isCollapsed = !!(data && data.flashcardSidebarCollapsed);
  layout.classList.toggle("sidebar-collapsed", isCollapsed);
  
  const toggleBtn = el("sidebarToggleBtn");
  if (toggleBtn) {
    toggleBtn.textContent = isCollapsed ? "▶" : "◀";
    toggleBtn.title = isCollapsed ? "Expand Library" : "Collapse Library";
  }
}

let activePdfUrl = null;
let activeNoteKey = null;

// Drawing state variables
let canvas = null;
let ctx = null;
let isDrawing = false;
let currentTool = "pan";
let currentSize = 4;
let currentColor = "#7c67ff";
let strokes = []; // Vector array of completed strokes
let currentStroke = null; // Active drawing stroke points
let undoStack = []; // Popped strokes for Redo

function resizeCanvas() {
  if (!canvas || !ctx) return;
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
  redrawAllStrokes();
}

async function initCanvasDrawing(key, pageNum = 1) {
  canvas = el("pdfAnnotationCanvas");
  if (!canvas) return;
  ctx = canvas.getContext("2d");
  
  // Set up resize observer to scale canvas buffer dynamically
  const resizeObserver = new ResizeObserver(() => {
    resizeCanvas();
  });
  resizeObserver.observe(canvas);

  // Load strokes
  undoStack = [];
  const pageKey = `annotations:strokes:${currentUser}:${key}:page:${pageNum}`;
  try {
    strokes = await idb.get(pageKey) || [];
  } catch (err) {
    strokes = [];
  }
  redrawAllStrokes();

  // Mouse events
  canvas.addEventListener("mousedown", (e) => {
    if (currentTool === "pan") return;
    isDrawing = true;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    currentStroke = {
      tool: currentTool,
      size: currentSize,
      color: currentColor,
      points: [{ x: x / canvas.width, y: y / canvas.height }]
    };
    redrawAllStrokes();
  });

  canvas.addEventListener("mousemove", (e) => {
    if (!isDrawing || !currentStroke) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    currentStroke.points.push({ x: x / canvas.width, y: y / canvas.height });
    redrawAllStrokes();
  });

  const finishDrawing = async () => {
    if (isDrawing && currentStroke) {
      isDrawing = false;
      strokes.push(currentStroke);
      currentStroke = null;
      undoStack = []; // Clear redo stack on new actions
      try {
        await idb.set(pageKey, strokes);
      } catch (err) {
        console.error("Failed to save stroke annotations:", err);
      }
    }
  };

  canvas.addEventListener("mouseup", finishDrawing);
  canvas.addEventListener("mouseout", finishDrawing);

  // Touch support
  canvas.addEventListener("touchstart", (e) => {
    if (currentTool === "pan") return;
    isDrawing = true;
    const touch = e.touches[0];
    const rect = canvas.getBoundingClientRect();
    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;
    
    currentStroke = {
      tool: currentTool,
      size: currentSize,
      color: currentColor,
      points: [{ x: x / canvas.width, y: y / canvas.height }]
    };
  });

  canvas.addEventListener("touchmove", (e) => {
    if (!isDrawing || !currentStroke) return;
    const touch = e.touches[0];
    const rect = canvas.getBoundingClientRect();
    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;
    
    currentStroke.points.push({ x: x / canvas.width, y: y / canvas.height });
    redrawAllStrokes();
    e.preventDefault();
  });

  canvas.addEventListener("touchend", finishDrawing);

  // Tool binding
  document.querySelectorAll(".notes-tools-sidebar .tool-btn[data-tool]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".notes-tools-sidebar .tool-btn[data-tool]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentTool = btn.dataset.tool;
      
      const viewport = el("pdfViewport");
      if (viewport) {
        viewport.classList.toggle("drawing-active", currentTool !== "pan");
      }
    });
  });

  // Color binding
  document.querySelectorAll(".color-palette .color-dot").forEach((dot) => {
    dot.addEventListener("click", () => {
      document.querySelectorAll(".color-palette .color-dot").forEach(d => d.classList.remove("active"));
      dot.classList.add("active");
      currentColor = dot.dataset.color;
    });
  });

  // Size binding
  const slider = el("toolSizeSlider");
  if (slider) {
    slider.addEventListener("input", (e) => {
      currentSize = parseInt(e.target.value) || 4;
    });
  }

  // Clear button
  const clearBtn = el("clearCanvasBtn");
  if (clearBtn) {
    clearBtn.addEventListener("click", async () => {
      if (confirm("Clear all note annotations on this page?")) {
        strokes = [];
        currentStroke = null;
        undoStack = [];
        redrawAllStrokes();
        try {
          await idb.set(pageKey, strokes);
        } catch (err) {
          console.error("Failed to clear annotations:", err);
        }
      }
    });
  }

  // Undo button
  const undoBtn = el("undoCanvasBtn");
  if (undoBtn) {
    undoBtn.addEventListener("click", async () => {
      if (strokes.length > 0) {
        const popped = strokes.pop();
        undoStack.push(popped);
        redrawAllStrokes();
        try {
          await idb.set(pageKey, strokes);
        } catch (err) {
          console.error("Failed to save stroke annotations:", err);
        }
      }
    });
  }

  // Redo button
  const redoBtn = el("redoCanvasBtn");
  if (redoBtn) {
    redoBtn.addEventListener("click", async () => {
      if (undoStack.length > 0) {
        const restored = undoStack.pop();
        strokes.push(restored);
        redrawAllStrokes();
        try {
          await idb.set(pageKey, strokes);
        } catch (err) {
          console.error("Failed to save stroke annotations:", err);
        }
      }
    });
  }
}

function redrawAllStrokes() {
  if (!canvas || !ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  // Render completed strokes
  strokes.forEach(drawStrokePath);
  
  // Render current drawing stroke
  if (currentStroke) {
    drawStrokePath(currentStroke);
  }
}

function drawStrokePath(stroke) {
  if (!stroke.points || stroke.points.length === 0) return;
  
  ctx.beginPath();
  const pt0 = stroke.points[0];
  ctx.moveTo(pt0.x * canvas.width, pt0.y * canvas.height);
  
  for (let i = 1; i < stroke.points.length; i++) {
    const pt = stroke.points[i];
    ctx.lineTo(pt.x * canvas.width, pt.y * canvas.height);
  }
  
  ctx.lineWidth = stroke.size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  
  if (stroke.tool === "highlighter") {
    ctx.strokeStyle = convertHexToRGBA(stroke.color, 0.4);
  } else {
    ctx.strokeStyle = stroke.color;
  }
  
  ctx.stroke();
}

function convertHexToRGBA(hex, alpha) {
  let r = 124, g = 103, b = 255;
  if (hex.startsWith("#")) {
    const num = parseInt(hex.substring(1), 16);
    r = (num >> 16) & 255;
    g = (num >> 8) & 255;
    b = num & 255;
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Window resize listener
window.addEventListener("resize", () => {
  if (canvas && ctx) resizeCanvas();
});

async function renderFileReaderTab() {
  const isHost = !!(data && data.isHost);
  const hostUpload = el("hostUploadWrapper");
  if (hostUpload) {
    hostUpload.classList.toggle("hidden", !isHost);
  }

  // Clear inputs
  el("personalNotesInput").value = "";
  if (el("hostNotesInput")) el("hostNotesInput").value = "";

  // 1. Render Personal Notes
  const personalList = el("personalNotesList");
  personalList.innerHTML = "";
  
  const personalNotes = data.notesList || [];
  if (personalNotes.length === 0) {
    personalList.innerHTML = `<div class="empty-state-small" style="font-size: 11px; color: var(--muted); text-align: center; padding: 12px 0;">No personal notes uploaded yet.</div>`;
  } else {
    personalNotes.forEach((note) => {
      const item = document.createElement("div");
      const key = `notes:personal:${currentUser}:${note.filename}`;
      item.className = `notes-file-item ${activeNoteKey === key ? "active" : ""}`;
      
      const sizeStr = (note.size / (1024 * 1024)).toFixed(2) + " MB";
      
      item.innerHTML = `
        <div class="notes-file-info" onclick="viewNote('${key}', '${escapeHtml(note.filename)}')">
          <span class="notes-file-icon">🖹</span>
          <div class="notes-file-meta">
            <span class="notes-file-name" title="${escapeHtml(note.filename)}">${escapeHtml(note.filename)}</span>
            <span class="notes-file-details">${sizeStr} · ${new Date(note.timestamp).toLocaleDateString()}</span>
          </div>
        </div>
        <button class="notes-file-delete" type="button" onclick="deletePersonalNote('${escapeHtml(note.filename)}', event)" title="Delete note">✕</button>
      `;
      personalList.append(item);
    });
  }

  // 2. Render Shared References (Global Host Files)
  const sharedList = el("sharedNotesList");
  sharedList.innerHTML = "";

  let allKeys = [];
  try {
    allKeys = await idb.keys();
  } catch (err) {
    console.error("Failed to read IndexedDB keys:", err);
  }

  const globalKeys = allKeys.filter(k => k.startsWith("notes:global:"));
  if (globalKeys.length === 0) {
    sharedList.innerHTML = `<div class="empty-state-small" style="font-size: 11px; color: var(--muted); text-align: center; padding: 12px 0;">No shared reference documents.</div>`;
  } else {
    globalKeys.forEach((key) => {
      const filename = key.substring("notes:global:".length);
      const item = document.createElement("div");
      item.className = `notes-file-item ${activeNoteKey === key ? "active" : ""}`;
      
      item.innerHTML = `
        <div class="notes-file-info" onclick="viewNote('${key}', '${escapeHtml(filename)}')">
          <span class="notes-file-icon" style="color: var(--mint);">🗎</span>
          <div class="notes-file-meta">
            <span class="notes-file-name" title="${escapeHtml(filename)}">${escapeHtml(filename)}</span>
            <span class="notes-file-details">Shared Reference</span>
          </div>
        </div>
        ${isHost ? `<button class="notes-file-delete" type="button" onclick="deleteHostNote('${escapeHtml(filename)}', event)" title="Delete Shared note">✕</button>` : ""}
      `;
      sharedList.append(item);
    });
  }

  // Sync the workspace Notepad textarea content if a file is currently active
  if (activeNoteKey) {
    const filename = activeNoteKey.split(":").pop();
    const linkedKey = `notes:text:linked:${currentUser}:${filename}`;
    try {
      const text = await idb.get(linkedKey) || "";
      const textarea = el("workspaceNoteTextarea");
      if (textarea) {
        textarea.value = text;
      }
    } catch (err) {
      console.error("Failed to load active note text on tab render:", err);
    }
  }
}

let activeEditorNoteId = null;
let activeEditorNoteType = null;

async function renderNotesTab() {
  // 1. Render PDF summaries (linked notes)
  const linkedList = el("notesLinkedDirectoryList");
  linkedList.innerHTML = "";

  const personalNotes = data.notesList || [];
  let allKeys = [];
  try {
    allKeys = await idb.keys();
  } catch (err) {
    console.error("Failed to read IndexedDB keys:", err);
  }

  const globalNotes = allKeys
    .filter((k) => k.startsWith("notes:global:"))
    .map((k) => k.substring("notes:global:".length));

  const allPdfs = [...new Set([...globalNotes, ...personalNotes.map((n) => n.filename)])];

  if (allPdfs.length === 0) {
    linkedList.innerHTML = `<div class="empty-state-small" style="font-size: 10px; color: var(--muted); text-align: center; padding: 12px 0;">No PDFs found. Upload files in the File Reader first!</div>`;
  } else {
    allPdfs.forEach((filename) => {
      const item = document.createElement("div");
      item.className = `notes-file-item ${activeEditorNoteId === filename ? "active" : ""}`;
      item.innerHTML = `
        <div class="notes-file-info" onclick="loadEditorNote('${escapeHtml(filename)}', 'linked')">
          <span class="notes-file-icon">🖹</span>
          <div class="notes-file-meta">
            <span class="notes-file-name" title="${escapeHtml(filename)}">${escapeHtml(filename)}</span>
            <span class="notes-file-details">PDF Summary</span>
          </div>
        </div>
      `;
      linkedList.append(item);
    });
  }

  // 2. Render Independent Notes
  const unlinkedList = el("notesUnlinkedDirectoryList");
  unlinkedList.innerHTML = "";

  const unlinkedNotes = data.unlinkedNotes || [];
  if (unlinkedNotes.length === 0) {
    unlinkedList.innerHTML = `<div class="empty-state-small" style="font-size: 10px; color: var(--muted); text-align: center; padding: 12px 0;">No independent notes. Click "+ Create New Note" above!</div>`;
  } else {
    unlinkedNotes.forEach((note) => {
      const item = document.createElement("div");
      item.className = `notes-file-item ${activeEditorNoteId === note.id ? "active" : ""}`;
      item.innerHTML = `
        <div class="notes-file-info" onclick="loadEditorNote('${escapeHtml(note.id)}', 'unlinked')">
          <span class="notes-file-icon" style="color: var(--mint);">✎</span>
          <div class="notes-file-meta">
            <span class="notes-file-name" title="${escapeHtml(note.title)}">${escapeHtml(note.title || "Untitled Note")}</span>
            <span class="notes-file-details">${new Date(note.timestamp).toLocaleDateString()}</span>
          </div>
        </div>
      `;
      unlinkedList.append(item);
    });
  }

  // 3. Render editor workspace state
  const emptyState = el("editorEmptyState");
  const activeWorkspace = el("editorActiveWorkspace");
  const deleteBtn = el("deleteActiveNoteBtn");
  const previewBtn = el("toggleNotePreviewBtn");
  const downloadBtn = el("downloadNoteBtn");
  const previewPane = el("noteMarkdownPreview");
  const noteTextarea = el("noteContentTextarea");

  if (previewPane) previewPane.classList.add("hidden");
  if (noteTextarea) noteTextarea.classList.remove("hidden");

  if (!activeEditorNoteId) {
    if (emptyState) emptyState.classList.remove("hidden");
    if (activeWorkspace) activeWorkspace.classList.add("hidden");
    if (deleteBtn) deleteBtn.classList.add("hidden");
    if (previewBtn) {
      previewBtn.classList.add("hidden");
      previewBtn.textContent = "👁 Preview";
    }
    if (downloadBtn) downloadBtn.classList.add("hidden");
    el("activeEditorNoteTitle").textContent = "No Note Selected";
  } else {
    if (emptyState) emptyState.classList.add("hidden");
    if (activeWorkspace) activeWorkspace.classList.remove("hidden");
    if (deleteBtn) deleteBtn.classList.toggle("hidden", activeEditorNoteType !== "unlinked");
    if (previewBtn) {
      previewBtn.classList.remove("hidden");
      previewBtn.textContent = "👁 Preview";
    }
    if (downloadBtn) downloadBtn.classList.remove("hidden");

    if (activeEditorNoteType === "linked") {
      el("activeEditorNoteTitle").textContent = `Summary: ${activeEditorNoteId}`;
      const noteKey = `notes:text:linked:${currentUser}:${activeEditorNoteId}`;
      const content = await idb.get(noteKey) || "";

      el("noteTitleInput").value = `Summary: ${activeEditorNoteId}`;
      el("noteTitleInput").disabled = true;
      noteTextarea.value = content;
    } else {
      const note = (data.unlinkedNotes || []).find((n) => n.id === activeEditorNoteId);
      if (note) {
        el("activeEditorNoteTitle").textContent = note.title || "Untitled Note";
        el("noteTitleInput").value = note.title || "";
        el("noteTitleInput").disabled = false;
        noteTextarea.value = note.content || "";
      }
    }
  }
}

async function loadEditorNote(id, type) {
  activeEditorNoteId = id;
  activeEditorNoteType = type;
  await renderNotesTab();
}

function createNewIndependentNote() {
  const noteId = "unlinked:" + Date.now().toString();
  const newNote = {
    id: noteId,
    title: "Untitled Note",
    content: "",
    timestamp: Date.now()
  };
  if (!data.unlinkedNotes) data.unlinkedNotes = [];
  data.unlinkedNotes.push(newNote);
  saveUser();

  activeEditorNoteId = noteId;
  activeEditorNoteType = "unlinked";
  renderNotesTab();
}

async function deleteActiveIndependentNote() {
  if (activeEditorNoteType !== "unlinked" || !activeEditorNoteId) return;

  const note = (data.unlinkedNotes || []).find((n) => n.id === activeEditorNoteId);
  const title = note ? note.title : "this note";

  if (!confirm(`Are you sure you want to delete "${title}"?`)) return;

  data.unlinkedNotes = (data.unlinkedNotes || []).filter((n) => n.id !== activeEditorNoteId);
  saveUser();

  activeEditorNoteId = null;
  activeEditorNoteType = null;
  renderNotesTab();
}

async function saveActiveEditorNote() {
  if (!activeEditorNoteId) return;

  const titleVal = el("noteTitleInput").value.trim();
  const contentVal = el("noteContentTextarea").value;
  const status = el("editorSaveStatus");

  if (status) status.textContent = "Saving changes...";

  if (activeEditorNoteType === "linked") {
    const noteKey = `notes:text:linked:${currentUser}:${activeEditorNoteId}`;
    await idb.set(noteKey, contentVal);
    
    // Sync live to File Reader notepad if active
    const workspaceTextarea = el("workspaceNoteTextarea");
    if (workspaceTextarea && activeNoteKey && activeNoteKey.endsWith(activeEditorNoteId)) {
      workspaceTextarea.value = contentVal;
    }
  } else {
    const note = (data.unlinkedNotes || []).find((n) => n.id === activeEditorNoteId);
    if (note) {
      note.title = titleVal || "Untitled Note";
      note.content = contentVal;
      note.timestamp = Date.now();
      saveUser();
    }
  }

  if (status) status.textContent = "All changes saved locally";
}

window.loadEditorNote = loadEditorNote;
window.createNewIndependentNote = createNewIndependentNote;
window.deleteActiveIndependentNote = deleteActiveIndependentNote;

async function renderAnalyticsTab() {
  if (!data) return;

  // 1. Calculate overview metrics
  // Total study time sum
  const dailyStudy = data.dailyStudy || {};
  const totalSeconds = Object.values(dailyStudy).reduce((acc, val) => acc + (Number(val) || 0), 0);
  const totalHrs = Math.floor(totalSeconds / 3600);
  const totalMins = Math.floor((totalSeconds % 3600) / 60);
  el("analyticTotalHours").textContent = `${totalHrs}h ${totalMins}m`;

  // Flashcards total
  const totalReviews = Number(data.flashcards) || 0;
  el("analyticTotalCards").textContent = totalReviews.toLocaleString();

  // Focus sessions completed
  const dailySessions = data.dailySessions || {};
  const totalSessions = Object.values(dailySessions).reduce((acc, val) => acc + (Number(val) || 0), 0);
  el("analyticTotalSessions").textContent = totalSessions.toLocaleString();

  // Consistency Ratio: studied dates in last 30 days vs total tracked
  const dates = Object.keys(dailyStudy);
  const activeDays = dates.filter(d => Number(dailyStudy[d]) > 0).length;
  const consistencyPercent = dates.length > 0 ? Math.round((activeDays / Math.max(30, dates.length)) * 100) : 0;
  el("analyticConsistency").textContent = `${consistencyPercent}%`;

  // 2. Render SVG Line Chart (Study Hours Trend - Last 7 Days)
  renderStudyHoursTrend();

  // 3. Render SVG Donut Chart (Anki Review Quality Breakdown)
  renderAnkiRatingsDonut();

  // 4. Render SVG Bar Chart (Daily Focus Sessions completed)
  renderSessionsBarChart();

  // 5. Render Study Frequency Heatmap
  renderActivityHeatmap();

  // 5.5. Render Subject Tag Study Distribution
  renderSubjectStudyDistribution();

  // 6. Validate & Unlock Achievements
  checkAchievements(totalSeconds, totalReviews, activeDays);
}

function renderStudyHoursTrend() {
  const container = el("studyHoursChartContainer");
  if (!container) return;

  // Calculate the last 7 dates
  const points = [];
  const labels = [];
  const now = new Date();
  
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const dateStr = d.toISOString().split("T")[0];
    const seconds = Number(data.dailyStudy?.[dateStr]) || 0;
    const hours = Number((seconds / 3600).toFixed(2));
    points.push(hours);
    labels.push(d.toLocaleDateString("en", { weekday: "short" }));
  }

  const maxVal = Math.max(2, ...points); // scale at least to 2h max
  const width = 450;
  const height = 200;
  const paddingLeft = 35;
  const paddingRight = 15;
  const paddingTop = 20;
  const paddingBottom = 30;
  
  const chartWidth = width - paddingLeft - paddingRight;
  const chartHeight = height - paddingTop - paddingBottom;

  // Coordinates
  const mappedPoints = points.map((val, i) => {
    const x = paddingLeft + (i / 6) * chartWidth;
    const y = paddingTop + chartHeight - (val / maxVal) * chartHeight;
    return { x, y };
  });

  // Build SVG Path
  let dPath = "";
  let dArea = "";
  mappedPoints.forEach((pt, i) => {
    if (i === 0) {
      dPath += `M ${pt.x} ${pt.y}`;
      dArea += `M ${pt.x} ${pt.y}`;
    } else {
      dPath += ` L ${pt.x} ${pt.y}`;
      dArea += ` L ${pt.x} ${pt.y}`;
    }
  });
  if (mappedPoints.length > 0) {
    dArea += ` L ${mappedPoints[mappedPoints.length - 1].x} ${height - paddingBottom} L ${mappedPoints[0].x} ${height - paddingBottom} Z`;
  }

  // Build Grid lines and labels
  let gridLines = "";
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const yVal = (maxVal * (i / ticks)).toFixed(1);
    const y = paddingTop + chartHeight - (i / ticks) * chartHeight;
    gridLines += `
      <line x1="${paddingLeft}" y1="${y}" x2="${width - paddingRight}" y2="${y}" class="chart-grid-line" />
      <text x="${paddingLeft - 8}" y="${y + 3}" class="chart-text" text-anchor="end">${yVal}h</text>
    `;
  }

  let xLabels = "";
  labels.forEach((lbl, i) => {
    const x = paddingLeft + (i / 6) * chartWidth;
    xLabels += `
      <text x="${x}" y="${height - 10}" class="chart-text" text-anchor="middle">${lbl}</text>
    `;
  });

  let dataPoints = "";
  mappedPoints.forEach((pt, i) => {
    dataPoints += `
      <circle cx="${pt.x}" cy="${pt.y}" class="chart-point" data-tooltip="${points[i]} hrs" />
    `;
  });

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" style="overflow: visible;">
      <defs>
        <linearGradient id="chartLineGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--purple)" stop-opacity="0.3"></stop>
          <stop offset="100%" stop-color="var(--purple)" stop-opacity="0.0"></stop>
        </linearGradient>
      </defs>
      <!-- Grid -->
      ${gridLines}
      <!-- Area under curve -->
      ${dPath ? `<path d="${dArea}" class="chart-line-gradient" />` : ""}
      <!-- Line -->
      ${dPath ? `<path d="${dPath}" class="chart-line" />` : ""}
      <!-- Points -->
      ${dataPoints}
      <!-- X Labels -->
      ${xLabels}
    </svg>
  `;
}

function renderAnkiRatingsDonut() {
  const container = el("ankiRatingsChartContainer");
  if (!container) return;

  const ratings = data.flashcardRatings || { easy: 0, good: 0, hard: 0 };
  const easy = ratings.easy || 0;
  const good = ratings.good || 0;
  const hard = ratings.hard || 0;
  const total = easy + good + hard;

  const radius = 60;
  const strokeWidth = 14;
  const circumference = 2 * Math.PI * radius; // ~376.99
  const center = 80;

  if (total === 0) {
    container.innerHTML = `
      <svg viewBox="0 0 160 160" width="160" height="160">
        <circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="var(--panel-2)" stroke-width="${strokeWidth}" />
        <text x="${center}" y="${center + 5}" class="donut-label-title">0</text>
        <text x="${center}" y="${center + 20}" class="donut-label-sub">Reviews</text>
      </svg>
    `;
    return;
  }

  // Segments details: color, count
  const segments = [
    { color: "var(--mint)", count: easy, label: "Easy" },
    { color: "var(--purple)", count: good, label: "Good" },
    { color: "var(--red)", count: hard, label: "Hard" }
  ].filter(s => s.count > 0);

  let accumulatedPercent = 0;
  let circlesHtml = "";

  segments.forEach((seg) => {
    const percent = seg.count / total;
    const offset = circumference - percent * circumference;
    const angle = accumulatedPercent * 360 - 90; // Start at top
    
    circlesHtml += `
      <circle cx="${center}" cy="${center}" r="${radius}" fill="none" 
              stroke="${seg.color}" stroke-width="${strokeWidth}"
              stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"
              transform="rotate(${angle} ${center} ${center})" class="donut-segment" />
    `;
    accumulatedPercent += percent;
  });

  // Render legend helper
  let legendHtml = `
    <div style="display:flex; flex-direction:column; gap:8px; font-size:11px; margin-left: 20px;">
  `;
  segments.forEach(seg => {
    const pct = Math.round((seg.count / total) * 100);
    legendHtml += `
      <div style="display:flex; align-items:center; gap:6px;">
        <div style="width:10px; height:10px; background:${seg.color}; border-radius:50%;"></div>
        <span style="color:var(--text); font-weight:700;">${seg.count}</span>
        <span style="color:var(--muted);">${seg.label} (${pct}%)</span>
      </div>
    `;
  });
  legendHtml += `</div>`;

  container.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:center; width:100%;">
      <svg viewBox="0 0 160 160" width="160" height="160">
        <!-- Backdrop Circle -->
        <circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="${strokeWidth}" />
        <!-- Slices -->
        ${circlesHtml}
        <!-- Text Inside -->
        <text x="${center}" y="${center - 2}" class="donut-label-title">${total}</text>
        <text x="${center}" y="${center + 14}" class="donut-label-sub">Reviews</text>
      </svg>
      ${legendHtml}
    </div>
  `;
}

function renderSessionsBarChart() {
  const container = el("sessionsBarChartContainer");
  if (!container) return;

  const points = [];
  const labels = [];
  const now = new Date();

  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const dateStr = d.toISOString().split("T")[0];
    const sessions = Number(data.dailySessions?.[dateStr]) || 0;
    points.push(sessions);
    labels.push(d.toLocaleDateString("en", { weekday: "short" }));
  }

  const maxVal = Math.max(4, ...points); // scaled to at least 4 sessions
  const width = 450;
  const height = 200;
  const paddingLeft = 30;
  const paddingRight = 15;
  const paddingTop = 20;
  const paddingBottom = 30;

  const chartWidth = width - paddingLeft - paddingRight;
  const chartHeight = height - paddingTop - paddingBottom;
  const barWidth = Math.max(12, (chartWidth / 7) - 16);

  let gridLines = "";
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const yVal = Math.round(maxVal * (i / ticks));
    const y = paddingTop + chartHeight - (i / ticks) * chartHeight;
    gridLines += `
      <line x1="${paddingLeft}" y1="${y}" x2="${width - paddingRight}" y2="${y}" class="chart-grid-line" />
      <text x="${paddingLeft - 8}" y="${y + 3}" class="chart-text" text-anchor="end">${yVal}</text>
    `;
  }

  let barsHtml = "";
  points.forEach((val, i) => {
    const x = paddingLeft + (i / 7) * chartWidth + 8;
    const barHeight = (val / maxVal) * chartHeight;
    const y = paddingTop + chartHeight - barHeight;

    barsHtml += `
      <rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" class="chart-bar" />
    `;
  });

  let xLabels = "";
  labels.forEach((lbl, i) => {
    const x = paddingLeft + (i / 7) * chartWidth + 8 + barWidth / 2;
    xLabels += `
      <text x="${x}" y="${height - 10}" class="chart-text" text-anchor="middle">${lbl}</text>
    `;
  });

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" style="overflow: visible;">
      <!-- Grid Grid -->
      ${gridLines}
      <!-- Bars Columns -->
      ${barsHtml}
      <!-- Labels -->
      ${xLabels}
    </svg>
  `;
}

function renderActivityHeatmap() {
  const container = el("activityHeatmapContainer");
  if (!container) return;
  container.innerHTML = "";

  const now = new Date();
  for (let i = 27; i >= 0; i--) { // 28 squares fits perfectly in a 7-wide grid!
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const dateStr = d.toISOString().split("T")[0];
    const seconds = Number(data.dailyStudy?.[dateStr]) || 0;
    
    // Choose color depth
    let depthStyle = "background: var(--panel-2);";
    if (seconds > 0) {
      if (seconds < 900) {
        depthStyle = "background: rgba(124, 103, 255, 0.25);";
      } else if (seconds < 3600) {
        depthStyle = "background: rgba(124, 103, 255, 0.55);";
      } else {
        depthStyle = "background: var(--purple);";
      }
    }

    const minStr = Math.round(seconds / 60);
    const tooltipText = `${d.toLocaleDateString("en", { month: "short", day: "numeric" })}: ${minStr}m focused`;

    const cell = document.createElement("div");
    cell.className = "heatmap-cell";
    cell.style.cssText = depthStyle;
    cell.setAttribute("data-tooltip", tooltipText);
    container.append(cell);
  }
}

function checkAchievements(totalSeconds, totalReviews, activeDays) {
  const isDeepWorker = totalSeconds >= 3600; // 1 hour study
  const isCardMaster = totalReviews >= 100;
  const isConsistent = activeDays >= 5;
  const isStreakMaster = (Number(data.streak) || 0) >= 3 || (Number(data.bestStreak) || 0) >= 3;

  const toggleBadge = (badgeId, unlocked) => {
    const b = el(badgeId);
    if (!b) return;
    b.classList.toggle("unlocked", unlocked);
    b.classList.toggle("locked", !unlocked);
  };

  toggleBadge("badgeDeepWorker", isDeepWorker);
  toggleBadge("badgeCardMaster", isCardMaster);
  toggleBadge("badgeConsistent", isConsistent);
  toggleBadge("badgeStreakMaster", isStreakMaster);
}

function renderSubjectStudyDistribution() {
  const container = el("subjectAnalyticsChartContainer");
  if (!container) return;

  const subjects = {
    "Path": 0,
    "Pharm": 0,
    "Exam": 0,
    "Review": 0
  };

  const tasks = data.tasks || [];
  tasks.forEach(t => {
    const tag = t.tag || "Review";
    if (subjects[tag] !== undefined) {
      subjects[tag]++;
    } else {
      subjects[tag] = 1;
    }
  });

  const labelMap = {
    "Path": "Pathology",
    "Pharm": "Pharmacology",
    "Exam": "Exams",
    "Review": "Revision"
  };

  const colors = {
    "Path": "#7c67ff",
    "Pharm": "#58ddd2",
    "Exam": "#ffb329",
    "Review": "#ff6e79"
  };

  const keys = Object.keys(subjects);
  const maxCount = Math.max(...Object.values(subjects), 1);

  let svgContent = `<svg width="100%" height="200" viewBox="0 0 400 200" style="background: transparent;">`;

  keys.forEach((key, idx) => {
    const count = subjects[key];
    const percentage = count / maxCount;
    const barWidth = Math.round(percentage * 240);
    const y = 20 + idx * 42;
    const color = colors[key] || "#7c67ff";
    const label = labelMap[key] || key;

    svgContent += `
      <!-- Label -->
      <text x="15" y="${y + 14}" fill="var(--soft)" font-size="11" font-weight="600">${escapeHtml(label)}</text>
      
      <!-- Base track -->
      <rect x="110" y="${y}" width="240" height="18" rx="9" fill="var(--panel-2)" />
      
      <!-- Colored bar -->
      <rect x="110" y="${y}" width="${Math.max(8, barWidth)}" height="18" rx="9" fill="${color}" />
      
      <!-- Value badge -->
      <text x="${120 + barWidth}" y="${y + 13}" fill="var(--text)" font-size="10" font-weight="700">${count}</text>
    `;
  });

  svgContent += `</svg>`;
  container.innerHTML = svgContent;
}

async function renderLibraryTab() {
  try {
    if (!data) return;

    const grid = el("libraryItemsGrid");
    if (!grid) return;

    const searchQuery = el("librarySearchInput")?.value.trim().toLowerCase() || "";
    const activeFilterBtn = document.querySelector(".library-filter-tabs .lib-tab.active");
    const filter = activeFilterBtn ? activeFilterBtn.dataset.filter : "all";

    // 1. Gather all assets
    // PDF Files (Personal + Shared)
    const pdfFiles = [];
    (data.notesList || []).forEach(f => {
      if (typeof f === "string") {
        pdfFiles.push({
          filename: f,
          size: 0,
          timestamp: Date.now(),
          isGlobal: false
        });
      } else if (f && typeof f === "object") {
        pdfFiles.push({
          filename: f.filename || "Untitled PDF",
          size: f.size || 0,
          timestamp: f.timestamp || Date.now(),
          isGlobal: false
        });
      }
    });

    let allKeys = [];
    try {
      allKeys = await idb.keys();
    } catch (err) {
      console.error("Failed to read IndexedDB keys:", err);
    }

    const globalKeys = allKeys.filter(k => k.startsWith("notes:global:"));
    globalKeys.forEach(key => {
      const filename = key.substring("notes:global:".length);
      if (!pdfFiles.some(f => f.filename === filename)) {
        pdfFiles.push({
          filename: filename,
          size: 0,
          timestamp: Date.now(),
          isGlobal: true
        });
      }
    });

    // Independent Notes
    const independentNotes = data.unlinkedNotes || [];

    // Linked summaries (read async from IndexedDB)
    const linkedNotes = [];
    await Promise.all(pdfFiles.map(async (file) => {
      const key = `notes:text:linked:${currentUser}:${file.filename}`;
      try {
        const text = await idb.get(key) || "";
        if (text.trim().length > 0) {
          linkedNotes.push({
            filename: file.filename,
            content: text
          });
        }
      } catch (err) {
        console.error("Failed to load linked note for library:", err);
      }
    }));

    // Flashcard Decks
    const decks = data.flashcardDecks || {};
    const deckNames = Object.keys(decks);

    // Update Stats labels
    if (el("libStatFiles")) el("libStatFiles").textContent = pdfFiles.length;
    if (el("libStatNotes")) el("libStatNotes").textContent = (independentNotes.length + linkedNotes.length);
    if (el("libStatDecks")) el("libStatDecks").textContent = deckNames.length;

    grid.innerHTML = "";

    // Compile unified items list
    const items = [];

    // Add PDFs
    pdfFiles.forEach(file => {
      const sizeMB = file.size ? (file.size / (1024 * 1024)).toFixed(2) + " MB" : "Shared Reference";
      items.push({
        type: "file",
        title: file.filename,
        meta: sizeMB,
        badgeClass: "badge-file",
        badgeText: file.isGlobal ? "Shared PDF" : "Personal PDF",
        searchStr: file.filename.toLowerCase(),
        actionFn: () => {
          const key = file.isGlobal ? `notes:global:${file.filename}` : `notes:personal:${currentUser}:${file.filename}`;
          openLibraryFile(key, file.filename);
        },
        buttonLabel: "Read PDF"
      });
    });

    // Add Independent Notes
    independentNotes.forEach(note => {
      const title = note.title || "Untitled Note";
      const content = note.content || "";
      const preview = content ? content.substring(0, 80) + (content.length > 80 ? "..." : "") : "Empty note";
      items.push({
        type: "note",
        title: title,
        meta: preview,
        badgeClass: "badge-note",
        badgeText: "Note",
        searchStr: (title + " " + content).toLowerCase(),
        actionFn: () => openLibraryNote(note.id, 'unlinked'),
        buttonLabel: "Edit Note"
      });
    });

    // Add Linked summaries
    linkedNotes.forEach(note => {
      const content = note.content || "";
      const preview = content ? content.substring(0, 80) + (content.length > 80 ? "..." : "") : "";
      items.push({
        type: "note",
        title: `${note.filename} (Summary)`,
        meta: preview,
        badgeClass: "badge-note",
        badgeText: "Summary",
        searchStr: (note.filename + " " + content).toLowerCase(),
        actionFn: () => openLibraryNote(note.filename, 'linked'),
        buttonLabel: "Edit Summary"
      });
    });

    // Add Decks
    deckNames.forEach(name => {
      const cardCount = decks[name].length;
      items.push({
        type: "deck",
        title: name,
        meta: `${cardCount} card${cardCount === 1 ? "" : "s"} inside`,
        badgeClass: "badge-deck",
        badgeText: "Anki Deck",
        searchStr: name.toLowerCase(),
        actionFn: () => openLibraryDeck(name),
        buttonLabel: "Study Deck"
      });
    });

    // Filter & Search
    const filtered = items.filter(item => {
      const matchesSearch = item.searchStr.includes(searchQuery);
      const matchesFilter = filter === "all" || item.type === filter;
      return matchesSearch && matchesFilter;
    });

    if (filtered.length === 0) {
      grid.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--muted); border: 1px dashed var(--line); border-radius: 12px; background: var(--panel-2);">
          <div style="font-size: 24px; margin-bottom: 8px;">📭</div>
          <div style="font-size: 13px; font-weight: 700; color: var(--text);">No assets match your search/filter</div>
          <div style="font-size: 11px; margin-top: 4px;">Try modifying your keyword or switching filter views.</div>
        </div>
      `;
      return;
    }

    filtered.forEach(item => {
      const card = document.createElement("div");
      card.className = "library-card";
      
      const headerWrapper = document.createElement("div");
      headerWrapper.style.cssText = "display:flex; flex-direction:column; gap:8px;";
      
      const badge = document.createElement("span");
      badge.className = `library-badge ${item.badgeClass}`;
      badge.textContent = item.badgeText;
      headerWrapper.appendChild(badge);

      const titleNode = document.createElement("h4");
      titleNode.className = "library-card-title";
      titleNode.textContent = item.title;
      titleNode.title = item.title;
      headerWrapper.appendChild(titleNode);

      const metaNode = document.createElement("div");
      metaNode.className = "library-card-meta";
      metaNode.textContent = item.meta;
      headerWrapper.appendChild(metaNode);

      card.appendChild(headerWrapper);

      const actionsWrapper = document.createElement("div");
      actionsWrapper.className = "library-card-actions";
      
      const mainBtn = document.createElement("button");
      mainBtn.type = "button";
      mainBtn.className = "primary-action";
      mainBtn.textContent = item.buttonLabel;
      mainBtn.addEventListener("click", () => {
        item.actionFn();
      });
      actionsWrapper.appendChild(mainBtn);

      card.appendChild(actionsWrapper);
      grid.appendChild(card);
    });

  } catch (err) {
    console.error("Error in renderLibraryTab:", err);
  }
}

function openLibraryFile(key, filename) {
  const navBtn = document.querySelector('.nav-item[data-page="File Reader"]');
  if (navBtn) {
    navBtn.click();
    viewNote(key, filename);
  }
}

function openLibraryNote(id, type) {
  const navBtn = document.querySelector('.nav-item[data-page="Notes"]');
  if (navBtn) {
    navBtn.click();
    loadEditorNote(id, type);
  }
}

function openLibraryDeck(deckName) {
  const navBtn = document.querySelector('.nav-item[data-page="Flashcards"]');
  if (navBtn) {
    navBtn.click();
    startStudySession(deckName);
    renderFlashcardsTab();
  }
}

window.openLibraryFile = openLibraryFile;
window.openLibraryNote = openLibraryNote;
window.openLibraryDeck = openLibraryDeck;
window.renderLibraryTab = renderLibraryTab;

// Calendar State variables
let currentCalendarDate = new Date();
let currentCalendarView = "month"; // "month" | "week" | "day" | "agenda"
let miniCalendarActiveDate = new Date(); // for mini month overview sidebar

function renderCalendarTab() {
  if (!data) return;
  
  // 0. Update color labels in the sidebar dynamically and edit color listeners
  if (data.colorLabels) {
    document.querySelectorAll(".color-label-text").forEach(span => {
      const color = span.dataset.color;
      if (color && data.colorLabels[color]) {
        span.textContent = data.colorLabels[color];
      }
    });

    const modalColorSelect = el("modalEventColor");
    if (modalColorSelect) {
      const prevVal = modalColorSelect.value;
      modalColorSelect.innerHTML = `
        <option value="#ff6e79">${escapeHtml(data.colorLabels["#ff6e79"] || "Study Tasks")}</option>
        <option value="#7c67ff">${escapeHtml(data.colorLabels["#7c67ff"] || "Schedules")}</option>
        <option value="#58ddd2">${escapeHtml(data.colorLabels["#58ddd2"] || "Focus Sessions")}</option>
        <option value="#ffb329">${escapeHtml(data.colorLabels["#ffb329"] || "Other")}</option>
      `;
      if (prevVal) modalColorSelect.value = prevVal;
    }
  }

  // 1. Sync view select state
  const viewSelect = el("calendarViewSelect");
  if (viewSelect) {
    viewSelect.value = currentCalendarView;
  }

  // 2. Render sidebar mini calendar
  renderMiniCalendar();

  // 3. Update main calendar active month display text
  updateCalendarHeaderTitle();

  // 4. Compile all active calendar events (tasks, pomodoros, custom events)
  const events = gatherCalendarEvents();

  // 5. Render active view grid
  const gridContainer = el("calendarWorkspaceGrid");
  if (!gridContainer) return;
  gridContainer.innerHTML = "";

  if (currentCalendarView === "month") {
    renderMonthView(gridContainer, events);
  } else if (currentCalendarView === "week") {
    renderWeekView(gridContainer, events);
  } else if (currentCalendarView === "day") {
    renderDayView(gridContainer, events);
  } else if (currentCalendarView === "agenda") {
    renderAgendaView(gridContainer, events);
  }
}

function updateCalendarHeaderTitle() {
  const title = el("calendarActiveMonthTitle");
  if (!title) return;
  
  const options = { month: "long", year: "numeric" };
  if (currentCalendarView === "day") {
    options.day = "numeric";
  }
  
  title.textContent = currentCalendarDate.toLocaleDateString("en", options);
}

function adjustCalendarDate(offset) {
  if (currentCalendarView === "month") {
    currentCalendarDate.setMonth(currentCalendarDate.getMonth() + offset);
  } else if (currentCalendarView === "week") {
    currentCalendarDate.setDate(currentCalendarDate.getDate() + offset * 7);
  } else if (currentCalendarView === "day") {
    currentCalendarDate.setDate(currentCalendarDate.getDate() + offset);
  } else if (currentCalendarView === "agenda") {
    currentCalendarDate.setDate(currentCalendarDate.getDate() + offset * 7); // jumps weekly
  }
  miniCalendarActiveDate = new Date(currentCalendarDate);
  renderCalendarTab();
}

function gatherCalendarEvents() {
  const events = [];

  // 1. Integrate tasks
  if (data.tasks) {
    data.tasks.forEach((task, idx) => {
      const dateStr = task.date || getLocalDateString();
      events.push({
        id: "task-" + idx,
        type: "task",
        title: `Task: ${task.title}`,
        date: dateStr,
        startTime: "09:00",
        endTime: "10:00",
        color: task.color || "#ff6e79",
        desc: task.tag ? `Tag: ${task.tag}` : "Study Assistant Task"
      });
    });
  }

  // 2. Integrate Pomodoro focus logs
  if (data.dailyStudy) {
    Object.keys(data.dailyStudy).forEach(dateStr => {
      const seconds = data.dailyStudy[dateStr] || 0;
      if (seconds > 0) {
        const mins = Math.round(seconds / 60);
        events.push({
          id: "pomodoro-" + dateStr,
          type: "pomodoro",
          title: `Focus Session: ${mins}m`,
          date: dateStr,
          startTime: "14:00",
          endTime: "15:00",
          color: "#58ddd2", // Mint
          desc: "Completed study session time"
        });
      }
    });
  }

  // 3. Load Custom events
  if (data.calendarEvents) {
    data.calendarEvents.forEach(evt => {
      events.push({
        id: evt.id,
        type: "custom",
        title: evt.title,
        date: evt.date,
        startTime: evt.startTime || "10:00",
        endTime: evt.endTime || "11:00",
        color: evt.color || "#7c67ff",
        desc: evt.desc || ""
      });
    });
  }

  // Filter by active selected color checkboxes
  const activeColors = document.querySelectorAll(".cal-color-filter").length > 0
    ? Array.from(document.querySelectorAll(".cal-color-filter:checked")).map(cb => cb.value)
    : ["#ff6e79", "#7c67ff", "#58ddd2", "#ffb329"];

  return events.filter(e => activeColors.includes(e.color));
}

function renderMiniCalendar() {
  const container = el("miniCalendarGrid");
  const title = el("miniCalTitle");
  if (!container || !title) return;

  container.innerHTML = "";

  const year = miniCalendarActiveDate.getFullYear();
  const month = miniCalendarActiveDate.getMonth();

  title.textContent = miniCalendarActiveDate.toLocaleDateString("en", { month: "long", year: "numeric" });

  const firstDay = new Date(year, month, 1).getDay();
  const totalDays = new Date(year, month + 1, 0).getDate();
  const prevMonthTotalDays = new Date(year, month, 0).getDate();

  const todayStr = getLocalDateString();
  const activeDateStr = currentCalendarDate.toISOString().split("T")[0];

  // Draw previous month padding days
  for (let i = firstDay - 1; i >= 0; i--) {
    const day = prevMonthTotalDays - i;
    const cell = document.createElement("div");
    cell.className = "mini-cal-day-cell other-month";
    cell.textContent = day;
    const targetDate = new Date(year, month - 1, day);
    cell.addEventListener("click", () => {
      currentCalendarDate = targetDate;
      miniCalendarActiveDate = new Date(targetDate);
      renderCalendarTab();
    });
    container.appendChild(cell);
  }

  // Draw active month days
  for (let day = 1; day <= totalDays; day++) {
    const cell = document.createElement("div");
    cell.className = "mini-cal-day-cell";
    cell.textContent = day;
    
    const cellDate = new Date(year, month, day);
    const dateStr = cellDate.toISOString().split("T")[0];

    if (dateStr === todayStr) {
      cell.classList.add("today-highlight");
    }
    if (dateStr === activeDateStr) {
      cell.classList.add("active-selected");
    }

    cell.addEventListener("click", () => {
      currentCalendarDate = cellDate;
      renderCalendarTab();
    });
    container.appendChild(cell);
  }
}

function renderMonthView(container, events) {
  const year = currentCalendarDate.getFullYear();
  const month = currentCalendarDate.getMonth();

  const firstDay = new Date(year, month, 1).getDay();
  const totalDays = new Date(year, month + 1, 0).getDate();
  const prevMonthTotalDays = new Date(year, month, 0).getDate();

  const wrapper = document.createElement("div");
  wrapper.className = "calendar-month-grid";

  // Days headers
  const headers = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  headers.forEach(h => {
    const node = document.createElement("div");
    node.className = "calendar-header-day";
    node.textContent = h;
    wrapper.appendChild(node);
  });

  const todayStr = getLocalDateString();

  // Prev month padding
  for (let i = firstDay - 1; i >= 0; i--) {
    const day = prevMonthTotalDays - i;
    const cell = document.createElement("div");
    cell.className = "calendar-day-cell other-month";
    cell.innerHTML = `<span class="calendar-day-number">${day}</span>`;
    
    const targetDate = new Date(year, month - 1, day);
    const dateStr = targetDate.toISOString().split("T")[0];
    cell.addEventListener("click", () => {
      openCreateEventModal(dateStr);
    });
    wrapper.appendChild(cell);
  }

  // Active month days
  for (let day = 1; day <= totalDays; day++) {
    const cell = document.createElement("div");
    cell.className = "calendar-day-cell";
    
    const cellDate = new Date(year, month, day);
    const dateStr = cellDate.toISOString().split("T")[0];

    if (dateStr === todayStr) {
      cell.classList.add("today-cell");
    }

    cell.innerHTML = `<span class="calendar-day-number">${day}</span>`;
    
    // Fill events inside this day
    const dayEvents = events.filter(e => e.date === dateStr);
    dayEvents.forEach(evt => {
      const pill = document.createElement("div");
      pill.className = "calendar-event-pill";
      pill.style.background = evt.color;
      pill.textContent = evt.title;
      pill.addEventListener("click", (e) => {
        e.stopPropagation();
        if (evt.type === "custom") {
          openEditEventModal(evt.id);
        } else {
          alert(`${evt.title}\nTime: ${evt.startTime} - ${evt.endTime}\nDescription: ${evt.desc}`);
        }
      });
      cell.appendChild(pill);
    });

    cell.addEventListener("click", () => {
      openCreateEventModal(dateStr);
    });
    wrapper.appendChild(cell);
  }

  container.appendChild(wrapper);
}

function renderWeekView(container, events) {
  // Find start of week (Sunday)
  const startOfWeek = new Date(currentCalendarDate);
  const day = startOfWeek.getDay();
  startOfWeek.setDate(startOfWeek.getDate() - day);

  const wrapper = document.createElement("div");
  wrapper.className = "calendar-week-grid";

  // Top header cell
  const emptyCorner = document.createElement("div");
  emptyCorner.className = "calendar-week-hour-header";
  wrapper.appendChild(emptyCorner);

  const weekDates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(startOfWeek);
    d.setDate(startOfWeek.getDate() + i);
    weekDates.push(d);

    const colHeader = document.createElement("div");
    colHeader.className = "calendar-header-day";
    colHeader.style.padding = "4px 0";
    colHeader.innerHTML = `
      <div style="font-size:9px; font-weight:700; text-transform:uppercase;">${d.toLocaleDateString("en", { weekday: "short" })}</div>
      <div style="font-size:16px; font-weight:700; color:var(--text); margin-top:2px;">${d.getDate()}</div>
    `;
    wrapper.appendChild(colHeader);
  }

  // Hours rows layout (8:00 AM to 10:00 PM = 14 hours)
  const startHour = 8;
  const totalHours = 14;

  const sidebarCol = document.createElement("div");
  sidebarCol.style.display = "flex";
  sidebarCol.style.flexDirection = "column";
  
  for (let h = 0; h < totalHours; h++) {
    const lbl = document.createElement("div");
    lbl.className = "calendar-week-hour-label";
    const hourVal = startHour + h;
    const ampm = hourVal >= 12 ? "PM" : "AM";
    const displayHour = hourVal > 12 ? hourVal - 12 : hourVal;
    lbl.textContent = `${displayHour} ${ampm}`;
    sidebarCol.appendChild(lbl);
  }
  wrapper.appendChild(sidebarCol);

  // For each day column
  weekDates.forEach((colDate) => {
    const colStr = colDate.toISOString().split("T")[0];
    const col = document.createElement("div");
    col.className = "calendar-week-day-column";
    
    // Draw background slot grid
    for (let h = 0; h < totalHours; h++) {
      const slot = document.createElement("div");
      slot.className = "calendar-week-hour-slot";
      col.appendChild(slot);
    }

    // Place events
    const colEvents = events.filter(e => e.date === colStr);
    colEvents.forEach(evt => {
      const [sh, sm] = (evt.startTime || "10:00").split(":").map(Number);
      const [eh, em] = (evt.endTime || "11:00").split(":").map(Number);

      const startMinutes = (sh * 60 + sm) - (startHour * 60);
      const durationMinutes = (eh * 60 + em) - (sh * 60 + sm);
      const totalMinutesWindow = totalHours * 60;

      if (startMinutes >= 0 && startMinutes < totalMinutesWindow) {
        const topPct = (startMinutes / totalMinutesWindow) * 100;
        const heightPct = Math.min(100 - topPct, (durationMinutes / totalMinutesWindow) * 100);

        const pill = document.createElement("div");
        pill.className = "calendar-event-absolute-pill";
        pill.style.cssText = `top:${topPct}%; height:${heightPct}%; background:${evt.color};`;
        pill.innerHTML = `
          <div style="font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(evt.title)}</div>
          <div class="calendar-event-absolute-time">${evt.startTime} - ${evt.endTime}</div>
        `;

        pill.addEventListener("click", () => {
          if (evt.type === "custom") {
            openEditEventModal(evt.id);
          } else {
            alert(`${evt.title}\nTime: ${evt.startTime} - ${evt.endTime}\nDescription: ${evt.desc}`);
          }
        });

        col.appendChild(pill);
      }
    });

    col.addEventListener("click", (e) => {
      if (e.target !== col) return;
      const rect = col.getBoundingClientRect();
      const clickY = e.clientY - rect.top;
      const clickedPct = clickY / rect.height;
      const clickedMinutes = clickedPct * totalHours * 60;
      const clickedHour = Math.floor(clickedMinutes / 60) + startHour;
      const hourStr = clickedHour.toString().padStart(2, "0") + ":00";
      
      openCreateEventModal(colStr, hourStr);
    });

    wrapper.appendChild(col);
  });

  container.appendChild(wrapper);
}

function renderDayView(container, events) {
  const dateStr = currentCalendarDate.toISOString().split("T")[0];
  
  const wrapper = document.createElement("div");
  wrapper.className = "calendar-week-grid";
  wrapper.style.gridTemplateColumns = "50px 1fr";

  const emptyCorner = document.createElement("div");
  emptyCorner.className = "calendar-week-hour-header";
  wrapper.appendChild(emptyCorner);

  const colHeader = document.createElement("div");
  colHeader.className = "calendar-header-day";
  colHeader.innerHTML = `
    <div style="font-size:10px; font-weight:700; text-transform:uppercase;">${currentCalendarDate.toLocaleDateString("en", { weekday: "long" })}</div>
    <div style="font-size:18px; font-weight:700; color:var(--text); margin-top:2px;">${currentCalendarDate.getDate()}</div>
  `;
  wrapper.appendChild(colHeader);

  // Hour slots
  const startHour = 8;
  const totalHours = 14;

  const sidebarCol = document.createElement("div");
  for (let h = 0; h < totalHours; h++) {
    const lbl = document.createElement("div");
    lbl.className = "calendar-week-hour-label";
    const hourVal = startHour + h;
    const ampm = hourVal >= 12 ? "PM" : "AM";
    const displayHour = hourVal > 12 ? hourVal - 12 : hourVal;
    lbl.textContent = `${displayHour} ${ampm}`;
    sidebarCol.appendChild(lbl);
  }
  wrapper.appendChild(sidebarCol);

  const col = document.createElement("div");
  col.className = "calendar-week-day-column";
  
  for (let h = 0; h < totalHours; h++) {
    const slot = document.createElement("div");
    slot.className = "calendar-week-hour-slot";
    col.appendChild(slot);
  }

  // Place events
  const dayEvents = events.filter(e => e.date === dateStr);
  dayEvents.forEach(evt => {
    const [sh, sm] = (evt.startTime || "10:00").split(":").map(Number);
    const [eh, em] = (evt.endTime || "11:00").split(":").map(Number);

    const startMinutes = (sh * 60 + sm) - (startHour * 60);
    const durationMinutes = (eh * 60 + em) - (sh * 60 + sm);
    const totalMinutesWindow = totalHours * 60;

    if (startMinutes >= 0 && startMinutes < totalMinutesWindow) {
      const topPct = (startMinutes / totalMinutesWindow) * 100;
      const heightPct = Math.min(100 - topPct, (durationMinutes / totalMinutesWindow) * 100);

      const pill = document.createElement("div");
      pill.className = "calendar-event-absolute-pill";
      pill.style.cssText = `top:${topPct}%; height:${heightPct}%; background:${evt.color};`;
      pill.innerHTML = `
        <div style="font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:11px;">${escapeHtml(evt.title)}</div>
        <div class="calendar-event-absolute-time" style="font-size:9px;">${evt.startTime} - ${evt.endTime}</div>
        ${evt.desc ? `<div style="font-size:9px; opacity:0.8; margin-top:2px;">${escapeHtml(evt.desc)}</div>` : ""}
      `;

      pill.addEventListener("click", () => {
        if (evt.type === "custom") {
          openEditEventModal(evt.id);
        } else {
          alert(`${evt.title}\nTime: ${evt.startTime} - ${evt.endTime}\nDescription: ${evt.desc}`);
        }
      });

      col.appendChild(pill);
    }
  });

  col.addEventListener("click", (e) => {
    if (e.target !== col) return;
    const rect = col.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const clickedPct = clickY / rect.height;
    const clickedMinutes = clickedPct * totalHours * 60;
    const clickedHour = Math.floor(clickedMinutes / 60) + startHour;
    const hourStr = clickedHour.toString().padStart(2, "0") + ":00";
    
    openCreateEventModal(dateStr, hourStr);
  });

  wrapper.appendChild(col);
  container.appendChild(wrapper);
}

function renderAgendaView(container, events) {
  const sorted = [...events].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.startTime.localeCompare(b.startTime);
  });

  const upcoming = sorted.filter(e => {
    const dateSplit = e.date.split("-").map(Number);
    const eventDate = new Date(dateSplit[0], dateSplit[1] - 1, dateSplit[2]);
    const activeDateCompare = new Date(currentCalendarDate.getFullYear(), currentCalendarDate.getMonth(), 1);
    return eventDate >= activeDateCompare;
  });

  if (upcoming.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 40px; color: var(--muted); border: 1px dashed var(--line); border-radius: 12px; background: var(--panel-2); margin: 20px;">
        <div style="font-size: 24px; margin-bottom: 8px;">📆</div>
        <div style="font-size: 13px; font-weight: 700; color: var(--text);">No events scheduled this month</div>
        <div style="font-size: 11px; margin-top: 4px;">Click "+ Create Event" to schedule an event.</div>
      </div>
    `;
    return;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "calendar-agenda-container";

  const groups = {};
  upcoming.forEach(evt => {
    if (!groups[evt.date]) groups[evt.date] = [];
    groups[evt.date].push(evt);
  });

  Object.keys(groups).sort().forEach(dateStr => {
    const dayEvents = groups[dateStr];
    const dateObj = new Date(dateStr.split("-").map(Number)[0], dateStr.split("-").map(Number)[1] - 1, dateStr.split("-").map(Number)[2]);

    const groupNode = document.createElement("div");
    groupNode.className = "calendar-agenda-day-group";
    
    groupNode.innerHTML = `
      <div class="calendar-agenda-day-title">
        <span>${dateObj.toLocaleDateString("en", { weekday: "long", month: "short", day: "numeric" })}</span>
      </div>
    `;

    dayEvents.forEach(evt => {
      const item = document.createElement("div");
      item.className = "calendar-agenda-item";
      
      item.innerHTML = `
        <div class="calendar-agenda-color" style="background:${evt.color};"></div>
        <div class="calendar-agenda-time">${evt.startTime} - ${evt.endTime}</div>
        <div class="calendar-agenda-title">${escapeHtml(evt.title)}</div>
        <div class="calendar-agenda-desc">${escapeHtml(evt.desc)}</div>
      `;

      item.addEventListener("click", () => {
        if (evt.type === "custom") {
          openEditEventModal(evt.id);
        } else {
          alert(`${evt.title}\nTime: ${evt.startTime} - ${evt.endTime}\nDescription: ${evt.desc}`);
        }
      });
      groupNode.appendChild(item);
    });

    wrapper.appendChild(groupNode);
  });

  container.appendChild(wrapper);
}

function openCreateEventModal(dateStr, timeStr = "09:00") {
  const modal = el("calendarEventModal");
  if (!modal) return;

  el("modalEventTitleLabel").textContent = "Create Calendar Event";
  el("modalEventId").value = "";
  el("modalEventTitle").value = "";
  el("modalEventDate").value = dateStr;
  el("modalEventStartTime").value = timeStr;
  
  const [h, m] = timeStr.split(":").map(Number);
  const endHour = Math.min(23, h + 1).toString().padStart(2, "0");
  el("modalEventEndTime").value = `${endHour}:${m.toString().padStart(2, "0")}`;
  
  el("modalEventColor").value = "#7c67ff";
  el("modalEventDesc").value = "";
  if (el("modalEventType")) {
    el("modalEventType").value = "custom";
  }
  
  el("deleteEventBtn").classList.add("hidden");
  modal.classList.remove("hidden");
}

function openEditEventModal(eventId) {
  const modal = el("calendarEventModal");
  if (!modal) return;

  let evt = (data.calendarEvents || []).find(e => e.id === eventId);
  let type = "custom";
  
  if (!evt) {
    evt = (data.tasks || []).find(t => t.id === eventId);
    type = "task";
  }

  if (!evt) return;

  el("modalEventTitleLabel").textContent = "Edit Calendar Event";
  el("modalEventId").value = evt.id;
  el("modalEventTitle").value = evt.title.replace(/^Task: /, "");
  el("modalEventDate").value = evt.date;
  el("modalEventStartTime").value = evt.startTime || "09:00";
  el("modalEventEndTime").value = evt.endTime || "10:00";
  el("modalEventColor").value = evt.color || "#ff6e79";
  el("modalEventDesc").value = evt.desc || "";
  if (el("modalEventType")) {
    el("modalEventType").value = type;
  }

  el("deleteEventBtn").classList.remove("hidden");
  modal.classList.remove("hidden");
}

async function saveCalendarEvent() {
  const title = el("modalEventTitle").value.trim();
  const date = el("modalEventDate").value;
  const startTime = el("modalEventStartTime").value;
  const endTime = el("modalEventEndTime").value;
  const color = el("modalEventColor").value;
  const desc = el("modalEventDesc").value.trim();
  const id = el("modalEventId").value;
  const type = el("modalEventType") ? el("modalEventType").value : "custom";

  if (!title || !date || !startTime || !endTime) {
    alert("Please fill in all required fields.");
    return;
  }

  if (startTime >= endTime) {
    alert("Start time must be before end time.");
    return;
  }

  data.calendarEvents = data.calendarEvents || [];
  data.tasks = data.tasks || [];

  const targetId = id || (type === "task" ? "task-" + Date.now() : "evt-" + Date.now());
  
  data.calendarEvents = data.calendarEvents.filter(e => e.id !== targetId);
  data.tasks = data.tasks.filter(t => t.id !== targetId);

  if (type === "task") {
    const newTask = {
      id: targetId,
      title: title,
      tag: "Review",
      done: false,
      is_completed: false,
      date,
      color,
      desc
    };
    data.tasks.push(newTask);
    if (currentSupabaseUser) {
      addSupabaseTodo(newTask);
    }
  } else {
    data.calendarEvents.push({
      id: targetId,
      title,
      date,
      startTime,
      endTime,
      color,
      desc
    });
  }

  saveUser();
  el("calendarEventModal").classList.add("hidden");
  renderCalendarTab();
  renderTasks();
}

async function deleteCalendarEvent(id) {
  if (confirm("Are you sure you want to delete this event?")) {
    data.calendarEvents = (data.calendarEvents || []).filter(e => e.id !== id);
    data.tasks = (data.tasks || []).filter(t => t.id !== id);
    if (currentSupabaseUser) {
      deleteSupabaseTodo({ id });
    }
    saveUser();
    el("calendarEventModal").classList.add("hidden");
    renderCalendarTab();
    renderTasks();
  }
}

// Sidebar month navigation adjuster helper
function adjustMiniMonth(offset) {
  miniCalendarActiveDate.setMonth(miniCalendarActiveDate.getMonth() + offset);
  renderMiniCalendar();
}

function exportCalendarToICS() {
  if (!data) return;
  const events = gatherCalendarEvents();
  
  let icsLines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Study Assistant//Study Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH"
  ];

  events.forEach(evt => {
    const dateClean = evt.date.replace(/-/g, "");
    
    icsLines.push("BEGIN:VEVENT");
    icsLines.push(`UID:${evt.id}@studyassistant.com`);
    
    const now = new Date();
    const stamp = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    icsLines.push(`DTSTAMP:${stamp}`);
    
    if (evt.type === "task") {
      icsLines.push(`DTSTART;VALUE=DATE:${dateClean}`);
      icsLines.push(`SUMMARY:${evt.title}`);
    } else {
      const startClean = (evt.startTime || "09:00").replace(":", "") + "00";
      const endClean = (evt.endTime || "10:00").replace(":", "") + "00";
      icsLines.push(`DTSTART;VALUE=DATE-TIME:${dateClean}T${startClean}`);
      icsLines.push(`DTEND;VALUE=DATE-TIME:${dateClean}T${endClean}`);
      icsLines.push(`SUMMARY:${evt.title}`);
    }
    
    if (evt.desc) {
      const cleanDesc = evt.desc.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
      icsLines.push(`DESCRIPTION:${cleanDesc}`);
    } else {
      icsLines.push("DESCRIPTION:Study Assistant Calendar Event");
    }
    
    icsLines.push("END:VEVENT");
  });

  icsLines.push("END:VCALENDAR");
  
  const icsString = icsLines.join("\r\n");
  
  const blob = new Blob([icsString], { type: "text/calendar;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.setAttribute("download", "study_calendar.ics");
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

window.openLibraryFile = openLibraryFile;
window.openLibraryNote = openLibraryNote;
window.openLibraryDeck = openLibraryDeck;
window.renderLibraryTab = renderLibraryTab;
window.renderCalendarTab = renderCalendarTab;
window.openCreateEventModal = openCreateEventModal;
window.openEditEventModal = openEditEventModal;

async function viewNote(key, filename) {
  activeNoteKey = key;
  
  // Re-run render to refresh active item state highlights
  renderFileReaderTab();

  const container = el("notesViewerContainer");
  const title = el("activeNoteTitle");
  const closeBtn = el("closeNoteBtn");
  const focusBtn = el("notesFocusToggleBtn");

  title.textContent = filename;
  closeBtn.classList.remove("hidden");
  if (focusBtn) {
    focusBtn.classList.remove("hidden");
    focusBtn.innerHTML = "⛶ Focus Mode";
    focusBtn.classList.remove("active");
  }

  const layout = document.querySelector(".notes-layout");
  if (layout) layout.classList.remove("reader-focused");
  document.body.classList.remove("notes-focus-active");

  container.innerHTML = `
    <div style="display:flex; justify-content:center; align-items:center; width:100%; height:100%; color:var(--muted);">
      Loading document viewer...
    </div>
  `;

  try {
    const fileBlob = await idb.get(key);
    if (!fileBlob) {
      container.innerHTML = `
        <div class="notes-empty-state">
          <div class="empty-icon" style="color:var(--red);">𛲠</div>
          <h3>Error loading file</h3>
          <p>The selected file could not be retrieved from the database.</p>
        </div>
      `;
      return;
    }

    // Revoke previous URL to prevent memory leak
    if (activePdfUrl) {
      URL.revokeObjectURL(activePdfUrl);
    }

    activePdfUrl = URL.createObjectURL(fileBlob);

    // Get existing linked note content
    const linkedKey = `notes:text:linked:${currentUser}:${filename}`;
    const linkedText = await idb.get(linkedKey) || "";

    container.innerHTML = `
      <div class="pdf-viewer-controls" style="display: flex; gap: 12px; align-items: center; background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 10px 16px; margin-bottom: 12px; font-size: 12px; color: var(--text); justify-content: center; width: 100%;">
        <span style="font-weight: 600;">Page Navigation:</span>
        <button type="button" id="pdfPrevPageBtn" style="background: var(--panel); border: 1px solid var(--line); border-radius: 4px; padding: 4px 8px; cursor: pointer; color: var(--text); font-size: 11px;">◀ Prev Page</button>
        <div style="display: flex; align-items: center; gap: 6px;">
          <span>Page</span>
          <input type="number" id="pdfPageJumpInput" value="1" min="1" style="width: 55px; padding: 4px; background: var(--panel); border: 1px solid var(--line); border-radius: 4px; color: var(--text); text-align: center; outline: none; font-size: 11px;" />
        </div>
        <button type="button" id="pdfNextPageBtn" style="background: var(--panel); border: 1px solid var(--line); border-radius: 4px; padding: 4px 8px; cursor: pointer; color: var(--text); font-size: 11px;">Next Page ▶</button>
      </div>

      <div class="pdf-viewer-wrapper">
        <div class="pdf-viewer-viewport" id="pdfViewport">
          <iframe id="pdfIframe" src="${activePdfUrl}#page=1&toolbar=0&navpanes=0&view=Fit" class="pdf-iframe-view" title="${escapeHtml(filename)}"></iframe>
          <canvas id="pdfAnnotationCanvas" class="pdf-annotation-canvas"></canvas>
        </div>
        
        <aside class="file-reader-workspace">
          <div class="workspace-notes-section">
            <label style="font-size: 10px; color: var(--muted); font-weight: 700; text-transform: uppercase;">Document Notepad</label>
            <textarea id="workspaceNoteTextarea" placeholder="Summarize pages or write down key findings related to this PDF note...">${escapeHtml(linkedText)}</textarea>
          </div>
          
          <div class="workspace-flashcard-section">
            <div style="font-size: 10px; color: var(--muted); font-weight: 750; text-transform: uppercase; margin-bottom: 4px;">Quick Flashcard</div>
            <div class="quick-card-form">
              <label>Front / Question</label>
              <textarea id="quickCardFront" placeholder="What is...?"></textarea>
              
              <label>Back / Answer</label>
              <textarea id="quickCardBack" placeholder="The definition/answer is..."></textarea>
              
              <label>Target Deck</label>
              <div style="display: flex; gap: 6px; align-items: center; width: 100%;">
                <select id="quickCardDeckSelect" style="flex: 1;"></select>
                <button type="button" class="primary-action" id="createQuickDeckBtn" style="padding: 6px 10px; font-size: 11px; margin-top: 0; width: auto; font-weight: bold;" title="Create New Deck">+</button>
              </div>
              
              <button type="button" class="primary-action" id="quickCardSubmitBtn" style="padding: 8px; font-size: 11px;">Create Flashcard</button>
            </div>
          </div>
        </aside>

        <aside class="notes-tools-sidebar">
          <div class="tool-section-title" style="margin-top: 0;">Mode</div>
          <button type="button" class="tool-btn active" data-tool="pan" title="Navigate Mode">🖱<span>Nav</span></button>
          <button type="button" class="tool-btn" data-tool="pen" title="Pencil Mode">✎<span>Pen</span></button>
          <button type="button" class="tool-btn" data-tool="highlighter" title="Highlight Mode">🖍<span>High</span></button>
          <button type="button" class="tool-btn" id="clearCanvasBtn" title="Clear Drawings" style="color: var(--red); border-color: rgba(255, 110, 121, 0.2);">↻<span>Clear</span></button>
          <button type="button" class="tool-btn" id="undoCanvasBtn" title="Undo Last Stroke" style="border-color: rgba(124, 103, 255, 0.2);">↶<span>Undo</span></button>
          <button type="button" class="tool-btn" id="redoCanvasBtn" title="Redo Stroke" style="border-color: rgba(124, 103, 255, 0.2);">↷<span>Redo</span></button>

          <div class="tool-section-title">Colors</div>
          <div class="color-palette">
            <button type="button" class="color-dot active" data-color="#7c67ff" style="background: #7c67ff;" title="Purple"></button>
            <button type="button" class="color-dot" data-color="#ffb329" style="background: #ffb329;" title="Amber"></button>
            <button type="button" class="color-dot" data-color="#58ddd2" style="background: #58ddd2;" title="Mint"></button>
            <button type="button" class="color-dot" data-color="#ff6e79" style="background: #ff6e79;" title="Red"></button>
            <button type="button" class="color-dot" data-color="#ffff00" style="background: #ffff00;" title="Yellow"></button>
          </div>

          <div class="tool-section-title">Size</div>
          <input type="range" id="toolSizeSlider" min="2" max="30" value="4" style="width: 100%; accent-color: var(--purple);" />
        </aside>
      </div>
    `;
    
    let currentPdfPage = 1;

    // Initialize canvas annotation engine
    initCanvasDrawing(key, currentPdfPage);

    // Bind PDF page controls
    const pageInput = el("pdfPageJumpInput");
    const prevBtn = el("pdfPrevPageBtn");
    const nextBtn = el("pdfNextPageBtn");
    const pdfIframe = el("pdfIframe");

    const updatePdfPage = (newPage) => {
      if (newPage < 1) newPage = 1;
      currentPdfPage = newPage;
      if (pageInput) pageInput.value = currentPdfPage;
      if (pdfIframe) {
        pdfIframe.src = `${activePdfUrl}#page=${currentPdfPage}&toolbar=0&navpanes=0&view=Fit`;
      }
      initCanvasDrawing(key, currentPdfPage);
    };

    if (pageInput) {
      pageInput.addEventListener("change", () => {
        const val = parseInt(pageInput.value) || 1;
        updatePdfPage(val);
      });
    }

    if (prevBtn) {
      prevBtn.addEventListener("click", () => {
        updatePdfPage(currentPdfPage - 1);
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener("click", () => {
        updatePdfPage(currentPdfPage + 1);
      });
    }

    // Auto-save notepad summary
    const workspaceNotesInput = el("workspaceNoteTextarea");
    if (workspaceNotesInput) {
      workspaceNotesInput.addEventListener("input", async (e) => {
        const text = e.target.value;
        await idb.set(linkedKey, text);
        
        // If the Notes tab editor is currently showing this same linked note, update it too!
        if (activeEditorNoteId === filename && activeEditorNoteType === "linked") {
          const editorTextarea = el("noteContentTextarea");
          if (editorTextarea) editorTextarea.value = text;
        }
      });
    }

    // Populate decks select options
    const deckSelect = el("quickCardDeckSelect");
    if (deckSelect) {
      deckSelect.innerHTML = "";
      const deckNames = Object.keys(data.flashcardDecks || {});
      if (deckNames.length === 0) {
        deckSelect.innerHTML = `<option value="">(No Decks Found)</option>`;
      } else {
        deckNames.forEach(name => {
          deckSelect.innerHTML += `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
        });
      }
    }

    const createQuickDeckBtn = el("createQuickDeckBtn");
    if (createQuickDeckBtn) {
      createQuickDeckBtn.addEventListener("click", () => {
        const name = prompt("Enter a name for the new deck:");
        if (!name) return;
        const deckName = name.trim();
        if (!deckName) return;

        data.flashcardDecks = data.flashcardDecks || {};
        if (data.flashcardDecks[deckName]) {
          alert(`A deck named "${deckName}" already exists.`);
          return;
        }

        data.flashcardDecks[deckName] = [];
        saveUser();
        saveFlashcardDecks();

        // Refresh select options and auto-select the new deck
        if (deckSelect) {
          deckSelect.innerHTML = "";
          Object.keys(data.flashcardDecks).forEach(name => {
            deckSelect.innerHTML += `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
          });
          deckSelect.value = deckName;
        }
        alert(`Deck "${deckName}" created successfully!`);
      });
    }

    // Add card quick creator click action
    const quickCardBtn = el("quickCardSubmitBtn");
    if (quickCardBtn) {
      quickCardBtn.addEventListener("click", async () => {
        const frontVal = el("quickCardFront").value.trim();
        const backVal = el("quickCardBack").value.trim();
        const targetDeck = el("quickCardDeckSelect").value;

        if (!frontVal || !backVal) {
          alert("Please enter both Front (Question) and Back (Answer) text.");
          return;
        }
        if (!targetDeck) {
          alert("Please select a target deck first. Import or create a deck in the Flashcards tab.");
          return;
        }

        const newCard = {
          front: frontVal,
          back: backVal,
          ord: Date.now()
        };

        if (!data.flashcardDecks[targetDeck]) {
          data.flashcardDecks[targetDeck] = [];
        }
        data.flashcardDecks[targetDeck].push(newCard);
        saveUser();
        saveFlashcardDecks();

        el("quickCardFront").value = "";
        el("quickCardBack").value = "";

        alert(`Card successfully added to deck: "${targetDeck}"!`);
      });
    }

  } catch (err) {
    console.error("Error displaying PDF note:", err);
    container.innerHTML = `
      <div class="notes-empty-state">
        <div class="empty-icon" style="color:var(--red);">𛲠</div>
        <h3>Failed to view note</h3>
        <p>An unexpected error occurred: ${escapeHtml(err.message)}</p>
      </div>
    `;
  }
}

function closeActiveNote() {
  activeNoteKey = null;
  if (activePdfUrl) {
    URL.revokeObjectURL(activePdfUrl);
    activePdfUrl = null;
  }
  
  canvas = null;
  ctx = null;
  isDrawing = false;
  currentTool = "pan";

  const layout = document.querySelector(".notes-layout");
  if (layout) layout.classList.remove("reader-focused");
  document.body.classList.remove("notes-focus-active");

  const focusBtn = el("notesFocusToggleBtn");
  if (focusBtn) {
    focusBtn.innerHTML = "⛶ Focus Mode";
    focusBtn.classList.remove("active");
    focusBtn.classList.add("hidden");
  }

  el("activeNoteTitle").textContent = "No Document Selected";
  el("closeNoteBtn").classList.add("hidden");

  el("notesViewerContainer").innerHTML = `
    <div class="notes-empty-state">
      <div class="empty-icon">🗀</div>
      <h3>Ready to read?</h3>
      <p>Select a shared reference or upload your own study guide PDF to start reading right here.</p>
    </div>
  `;
  renderFileReaderTab();
}

async function deletePersonalNote(filename, event) {
  if (event) event.stopPropagation();
  
  if (!confirm(`Are you sure you want to delete "${filename}"?`)) return;

  const key = `notes:personal:${currentUser}:${filename}`;
  
  try {
    await idb.delete(key);
    
    // Update user profile notesList
    data.notesList = (data.notesList || []).filter(note => note.filename !== filename);
    saveUser();

    // Close preview if we are deleting the active note
    if (activeNoteKey === key) {
      closeActiveNote();
    } else {
      renderFileReaderTab();
    }
  } catch (err) {
    console.error("Failed to delete note:", err);
    alert("Error deleting file: " + err.message);
  }
}

async function deleteHostNote(filename, event) {
  if (event) event.stopPropagation();
  
  if (!confirm(`Are you sure you want to delete the shared reference "${filename}"? This will delete it for ALL users.`)) return;

  const key = `notes:global:${filename}`;
  
  try {
    await idb.delete(key);

    // Close preview if we are deleting the active note
    if (activeNoteKey === key) {
      closeActiveNote();
    } else {
      renderFileReaderTab();
    }
  } catch (err) {
    console.error("Failed to delete shared note:", err);
    alert("Error deleting shared note: " + err.message);
  }
}

window.viewNote = viewNote;
window.deletePersonalNote = deletePersonalNote;
window.deleteHostNote = deleteHostNote;

function renderFlashcardsTab() {
  renderDeckList();
  updateSidebarUI();
  
  const container = el("studyViewContainer");
  const closeBtn = el("closeDeckBtn");
  if (!currentStudyDeck) {
    if (closeBtn) closeBtn.classList.add("hidden");
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">◈</div>
        <h3>Ready to study</h3>
        <p>Select an imported deck from the list on the left, or upload a new Anki deck package (.apkg) to start learning.</p>
      </div>
    `;
    el("studyKicker").textContent = "Active Study";
  } else {
    if (closeBtn) closeBtn.classList.remove("hidden");
    renderActiveCard();
  }
}

function renderDeckList() {
  const listContainer = el("deckList");
  listContainer.innerHTML = "";
  
  const decks = data.flashcardDecks || {};
  const deckNames = Object.keys(decks);
  
  if (deckNames.length === 0) {
    listContainer.innerHTML = `
      <p style="color: var(--muted); font-size: 13px; text-align: center; margin-top: 20px;">
        No decks imported yet.
      </p>
    `;
    return;
  }
  
  deckNames.sort();
  const rootNode = buildDeckTree(deckNames, decks);
  
  const childrenNames = Object.keys(rootNode.children);
  childrenNames.forEach(childName => {
    listContainer.appendChild(renderTreeNode(rootNode.children[childName], 0));
  });
}

function renderTreeNode(node, depth = 0) {
  const container = document.createElement("div");
  container.className = "deck-tree-node";
  
  const childrenNames = Object.keys(node.children);
  const isLeaf = childrenNames.length === 0;
  const isCollapsed = collapsedDecks.has(node.fullName);
  
  const header = document.createElement("div");
  header.className = `deck-item-header-tree ${currentStudyDeck === node.fullName ? "active" : ""}`;
  
  header.innerHTML = `
    <div class="deck-info-tree">
      ${!isLeaf ? `<span class="toggle-icon">${isCollapsed ? "▶" : "▼"}</span>` : `<span class="toggle-icon leaf">◈</span>`}
      <h3 class="deck-name" title="${escapeHtml(node.name)}">${escapeHtml(node.name)}</h3>
      <span class="card-count-badge">${node.cardsCount} cards</span>
    </div>
    <div class="deck-actions-tree">
      ${node.cardsCount > 0 ? `<button type="button" class="start-deck-btn-tree" data-deck="${escapeHtml(node.fullName)}">Study</button>` : ""}
      <button type="button" class="delete-deck-btn-tree" title="Delete Deck" data-deck="${escapeHtml(node.fullName)}">✕</button>
    </div>
  `;
  
  header.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    if (!isLeaf) {
      if (collapsedDecks.has(node.fullName)) {
        collapsedDecks.delete(node.fullName);
      } else {
        collapsedDecks.add(node.fullName);
      }
      renderDeckList();
    }
  });
  
  const startBtn = header.querySelector(".start-deck-btn-tree");
  if (startBtn) {
    startBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      startStudySession(node.fullName);
    });
  }
  
  const deleteBtn = header.querySelector(".delete-deck-btn-tree");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm(`Are you sure you want to delete "${node.fullName}" (including all subdecks)?`)) {
        deleteDeckAndSubdecks(node.fullName);
      }
    });
  }
  
  container.appendChild(header);
  
  if (!isLeaf && !isCollapsed) {
    const childrenContainer = document.createElement("div");
    childrenContainer.className = "deck-tree-children";
    childrenNames.forEach(childName => {
      childrenContainer.appendChild(renderTreeNode(node.children[childName], depth + 1));
    });
    container.appendChild(childrenContainer);
  }
  
  return container;
}

function deleteDeck(name) {
  if (data.flashcardDecks && data.flashcardDecks[name]) {
    delete data.flashcardDecks[name];
    saveFlashcardDecks();
    saveUser();
  }
  if (currentStudyDeck === name) {
    currentStudyDeck = null;
    currentStudyCards = [];
    currentCardIndex = 0;
    cardFlipped = false;
    cardShownTime = null;
  }
  renderFlashcardsTab();
}

function getDeckCards(deckName) {
  const cards = [];
  if (data.flashcardDecks[deckName]) {
    cards.push(...data.flashcardDecks[deckName]);
  }
  const prefix = deckName + "::";
  for (const name in data.flashcardDecks) {
    if (name.startsWith(prefix)) {
      cards.push(...data.flashcardDecks[name]);
    }
  }
  return cards;
}

function startStudySession(deckName) {
  currentStudyDeck = deckName;
  currentStudyCards = getDeckCards(deckName);
  currentCardIndex = 0;
  cardFlipped = false;
  
  document.querySelectorAll(".deck-item-header-tree").forEach(item => {
    const studyBtn = item.querySelector(".start-deck-btn-tree");
    const itemDeck = studyBtn ? studyBtn.dataset.deck : null;
    item.classList.toggle("active", itemDeck === deckName);
  });
  
  renderActiveCard();
}

function renderActiveCard() {
  const container = el("studyViewContainer");
  el("studyKicker").textContent = `Deck: ${currentStudyDeck}`;
  
  if (currentCardIndex >= currentStudyCards.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">🎉</div>
        <h3>Deck Completed!</h3>
        <p>Excellent work. You have reviewed all ${currentStudyCards.length} cards in this deck.</p>
        <button type="button" class="primary-action" id="restartDeckBtn" style="margin-top: 10px;">Review Again</button>
      </div>
    `;
    
    el("restartDeckBtn").addEventListener("click", () => {
      startStudySession(currentStudyDeck);
    });
    return;
  }
  
  if (!cardShownTime) {
    cardShownTime = Date.now();
  }
  
  const card = currentStudyCards[currentCardIndex];
  
  const frontHtml = renderImageOcclusionHTML(card, false);
  const backHtml = renderImageOcclusionHTML(card, true);
  const isLarge = shouldCardBeLarge(card);
  
  container.innerHTML = `
    <div class="ratings-stats-bar">
      <span>Easy: <b class="easy-val">${data.flashcardRatings?.easy || 0}</b></span>
      <span>Good: <b class="good-val">${data.flashcardRatings?.good || 0}</b></span>
      <span>Hard: <b class="hard-val">${data.flashcardRatings?.hard || 0}</b></span>
    </div>

    <div class="flashcard-container ${isLarge ? 'large-card' : ''}" id="flashcardContainer">
      <div class="flashcard-inner ${cardFlipped ? 'flipped' : ''}" id="flashcardInner">
        <div class="flashcard-face front">
          <div class="card-content">${frontHtml}</div>
          <div class="card-hint">Click card to reveal answer</div>
        </div>
        <div class="flashcard-face back">
          <div class="card-content">${backHtml}</div>
          <div class="card-hint">Click card to show question</div>
        </div>
      </div>
    </div>
    
    <div class="study-controls">
      <div class="study-progress">Card ${currentCardIndex + 1} of ${currentStudyCards.length}</div>
      <div id="cardActions" style="width: 100%;">
        ${cardFlipped ? `
          <div class="rating-buttons">
            <button type="button" data-rating="hard" id="rateHardBtn">Hard</button>
            <button type="button" data-rating="good" id="rateGoodBtn">Good</button>
            <button type="button" data-rating="easy" id="rateEasyBtn">Easy</button>
          </div>
        ` : `
          <button type="button" class="show-answer-btn" id="showAnswerBtn">Show Answer</button>
        `}
      </div>
    </div>
  `;
  
  const cardContainer = el("flashcardContainer");
  cardContainer.addEventListener("click", () => {
    cardFlipped = !cardFlipped;
    const inner = el("flashcardInner");
    inner.classList.toggle("flipped", cardFlipped);
    renderCardActions();
  });
  
  renderCardActions();
}

function renderCardActions() {
  const actionsContainer = el("cardActions");
  if (!actionsContainer) return;
  
  if (cardFlipped) {
    actionsContainer.innerHTML = `
      <div class="rating-buttons">
        <button type="button" data-rating="hard" id="rateHardBtn">Hard</button>
        <button type="button" data-rating="good" id="rateGoodBtn">Good</button>
        <button type="button" data-rating="easy" id="rateEasyBtn">Easy</button>
      </div>
    `;
    
    el("rateHardBtn").addEventListener("click", (e) => { e.stopPropagation(); rateCard("hard"); });
    el("rateGoodBtn").addEventListener("click", (e) => { e.stopPropagation(); rateCard("good"); });
    el("rateEasyBtn").addEventListener("click", (e) => { e.stopPropagation(); rateCard("easy"); });
  } else {
    actionsContainer.innerHTML = `
      <button type="button" class="show-answer-btn" id="showAnswerBtn">Show Answer</button>
    `;
    
    el("showAnswerBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      cardFlipped = true;
      el("flashcardInner").classList.add("flipped");
      renderCardActions();
    });
  }
}

function rateCard(rating) {
  let elapsed = 0;
  if (cardShownTime) {
    elapsed = (Date.now() - cardShownTime) / 1000;
    cardShownTime = null;
  }
  
  data.flashcards = (data.flashcards || 0) + 1;
  data.flashcardsToday = (data.flashcardsToday || 0) + 1;
  data.flashcardTotalTime = (data.flashcardTotalTime || 0) + elapsed;
  data.flashcardTotalCount = (data.flashcardTotalCount || 0) + 1;
  
  if (!data.flashcardRatings) {
    data.flashcardRatings = { easy: 0, good: 0, hard: 0 };
  }
  data.flashcardRatings[rating] = (data.flashcardRatings[rating] || 0) + 1;
  
  const todayStr = getLocalDateString();
  data.dailyFlashcards = data.dailyFlashcards || {};
  data.dailyFlashcards[todayStr] = data.flashcardsToday;
  
  saveUser();
  
  currentCardIndex++;
  cardFlipped = false;
  renderActiveCard();
}

function bindEvents() {
  el("loginTab").addEventListener("click", () => setAuthMode("login"));
  el("signupTab").addEventListener("click", () => setAuthMode("signup"));
  el("authForm").addEventListener("submit", handleAuth);
  
  const logoutBtn = el("logoutButton");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      if (currentSupabaseUser || currentUser) {
        openAuthModal();
      } else {
        openAuthModal("Please log in to sync your study tasks.");
      }
    });
  }

  const userBtn = el("userButton");
  if (userBtn) {
    userBtn.addEventListener("click", () => openAuthModal());
  }

  // Auth Modal controls
  const closeAuthModalBtn = el("closeAuthModalBtn");
  if (closeAuthModalBtn) {
    closeAuthModalBtn.addEventListener("click", closeAuthModal);
  }

  const authModal = el("authModal");
  if (authModal) {
    authModal.addEventListener("click", (e) => {
      if (e.target === authModal) closeAuthModal();
    });
  }

  const modalLoginTab = el("modalLoginTab");
  if (modalLoginTab) {
    modalLoginTab.addEventListener("click", () => setModalAuthMode("login"));
  }

  const modalSignupTab = el("modalSignupTab");
  if (modalSignupTab) {
    modalSignupTab.addEventListener("click", () => setModalAuthMode("signup"));
  }

  const modalAuthForm = el("modalAuthForm");
  if (modalAuthForm) {
    modalAuthForm.addEventListener("submit", handleModalAuth);
  }

  const modalLogoutBtn = el("modalLogoutBtn");
  if (modalLogoutBtn) {
    modalLogoutBtn.addEventListener("click", () => {
      logout();
      closeAuthModal();
    });
  }

  const modalSyncNowBtn = el("modalSyncNowBtn");
  if (modalSyncNowBtn) {
    modalSyncNowBtn.addEventListener("click", async () => {
      modalSyncNowBtn.textContent = "Syncing...";
      await fetchUserTodos();
      setTimeout(() => {
        modalSyncNowBtn.textContent = "Synced ✓";
        setTimeout(() => {
          modalSyncNowBtn.textContent = "🔄 Sync Now";
        }, 1200);
      }, 400);
    });
  }

  document.querySelectorAll(".nav-item[data-page]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      el("pageTitle").textContent = button.dataset.page;
      
      const targetPage = button.dataset.page;
      document.querySelectorAll(".page-view").forEach((page) => page.classList.add("hidden"));
      
      if (targetPage === "Dashboard") {
        el("dashboardPage").classList.remove("hidden");
        renderAll();
      } else if (targetPage === "Flashcards") {
        el("flashcardsPage").classList.remove("hidden");
        renderFlashcardsTab();
      } else if (targetPage === "File Reader") {
        el("fileReaderPage").classList.remove("hidden");
        renderFileReaderTab();
      } else if (targetPage === "Notes") {
        el("notesPage").classList.remove("hidden");
        renderNotesTab();
      } else if (targetPage === "Analytics") {
        el("analyticsPage").classList.remove("hidden");
        renderAnalyticsTab();
      } else if (targetPage === "Library") {
        el("libraryPage").classList.remove("hidden");
        renderLibraryTab();
      } else if (targetPage === "Calendar") {
        el("calendarPage").classList.remove("hidden");
        renderCalendarTab();
      }
    });
  });

  const searchInput = el("librarySearchInput");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      renderLibraryTab();
    });
  }

  document.querySelectorAll(".library-filter-tabs .lib-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".library-filter-tabs .lib-tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderLibraryTab();
    });
  });

  // Calendar Event Bindings
  const createEventBtn = el("createEventBtn");
  if (createEventBtn) {
    createEventBtn.addEventListener("click", () => {
      openCreateEventModal(new Date().toISOString().split("T")[0]);
    });
  }

  const calendarTodayBtn = el("calendarTodayBtn");
  if (calendarTodayBtn) {
    calendarTodayBtn.addEventListener("click", () => {
      currentCalendarDate = new Date();
      miniCalendarActiveDate = new Date(currentCalendarDate);
      renderCalendarTab();
    });
  }

  const prevCalMonthBtn = el("prevCalMonthBtn");
  if (prevCalMonthBtn) {
    prevCalMonthBtn.addEventListener("click", () => {
      adjustCalendarDate(-1);
    });
  }

  const nextCalMonthBtn = el("nextCalMonthBtn");
  if (nextCalMonthBtn) {
    nextCalMonthBtn.addEventListener("click", () => {
      adjustCalendarDate(1);
    });
  }

  const calendarViewSelect = el("calendarViewSelect");
  if (calendarViewSelect) {
    calendarViewSelect.addEventListener("change", (e) => {
      currentCalendarView = e.target.value;
      renderCalendarTab();
    });
  }

  const prevMiniMonthBtn = el("prevMiniMonthBtn");
  if (prevMiniMonthBtn) {
    prevMiniMonthBtn.addEventListener("click", () => {
      miniCalendarActiveDate.setMonth(miniCalendarActiveDate.getMonth() - 1);
      renderMiniCalendar();
    });
  }

  const nextMiniMonthBtn = el("nextMiniMonthBtn");
  if (nextMiniMonthBtn) {
    nextMiniMonthBtn.addEventListener("click", () => {
      miniCalendarActiveDate.setMonth(miniCalendarActiveDate.getMonth() + 1);
      renderMiniCalendar();
    });
  }

  // Color Filters checkboxes
  document.querySelectorAll(".cal-color-filter").forEach(cb => {
    cb.addEventListener("change", () => {
      renderCalendarTab();
    });
  });

  // Edit Color Labels (Custom Modal Renamer)
  document.querySelectorAll(".edit-color-label-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const color = btn.dataset.color;
      if (!color || !data.colorLabels) return;
      const currentLabel = data.colorLabels[color] || "Category";
      
      const modal = el("renameColorModal");
      if (modal) {
        el("renameColorHex").value = color;
        el("renameColorInput").value = currentLabel;
        modal.classList.remove("hidden");
      }
    });
  });

  const closeRenameBtn = el("closeRenameModalBtn");
  if (closeRenameBtn) {
    closeRenameBtn.addEventListener("click", () => {
      el("renameColorModal").classList.add("hidden");
    });
  }

  const cancelRenameBtn = el("cancelRenameModalBtn");
  if (cancelRenameBtn) {
    cancelRenameBtn.addEventListener("click", () => {
      el("renameColorModal").classList.add("hidden");
    });
  }

  const renameForm = el("renameColorForm");
  if (renameForm) {
    renameForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const color = el("renameColorHex").value;
      const label = el("renameColorInput").value.trim();
      if (color && label && data.colorLabels) {
        data.colorLabels[color] = label;
        saveUser();
        renderCalendarTab();
        renderTasks();
      }
      el("renameColorModal").classList.add("hidden");
    });
  }

  // Modal actions
  const closeEventModalBtn = el("closeEventModalBtn");
  if (closeEventModalBtn) {
    closeEventModalBtn.addEventListener("click", () => {
      el("calendarEventModal").classList.add("hidden");
    });
  }

  const cancelEventModalBtn = el("cancelEventModalBtn");
  if (cancelEventModalBtn) {
    cancelEventModalBtn.addEventListener("click", () => {
      el("calendarEventModal").classList.add("hidden");
    });
  }

  const deleteEventBtn = el("deleteEventBtn");
  if (deleteEventBtn) {
    deleteEventBtn.addEventListener("click", () => {
      const id = el("modalEventId").value;
      if (id) {
        deleteCalendarEvent(id);
      }
    });
  }

  const exportCalBtn = el("exportCalICSBtn");
  if (exportCalBtn) {
    exportCalBtn.addEventListener("click", () => {
      exportCalendarToICS();
    });
  }

  const calendarEventForm = el("calendarEventForm");
  if (calendarEventForm) {
    calendarEventForm.addEventListener("submit", (e) => {
      e.preventDefault();
      saveCalendarEvent();
    });
  }

  el("focusModeButton").addEventListener("click", () => {
    data.focusMode = !data.focusMode;
    saveUser();
    renderAll();
  });

  el("soundButton").addEventListener("click", () => {
    data.sound = !data.sound;
    saveUser();
    renderAll();
    if (data.sound) playTone("play");
  });

  document.querySelectorAll(".timer-mode").forEach((button) => {
    button.addEventListener("click", () => {
      data.timerMode = button.dataset.mode;
      data.timerRemaining = getTimerDuration(data.timerMode);
      data.timerRunning = false;
      saveUser();
      renderTimer();
    });
  });

  el("playTimer").addEventListener("click", () => {
    data.timerRunning = !data.timerRunning;
    if (data.timerRunning) {
      data.timerLastTick = Date.now();
      playTone("play");
    }
    saveUser();
    renderTimer();
  });

  el("resetTimer").addEventListener("click", () => {
    data.timerRemaining = getTimerDuration(data.timerMode);
    data.timerRunning = false;
    saveUser();
    renderTimer();
  });

  el("skipTimer").addEventListener("click", () => {
    completeTimerSession();
    saveUser();
    renderAll();
  });

  el("focusMinInput").addEventListener("input", (e) => {
    const val = Math.max(1, parseInt(e.target.value) || 1);
    data.timerFocusDurationMin = val;
    if (!data.timerRunning && data.timerMode === "focus") {
      data.timerRemaining = val * 60;
      el("timerText").textContent = formatTime(data.timerRemaining);
    }
  });
  el("focusMinInput").addEventListener("change", () => {
    saveUser();
    renderTimer();
  });

  el("breakMinInput").addEventListener("input", (e) => {
    const val = Math.max(1, parseInt(e.target.value) || 1);
    data.timerBreakDurationMin = val;
    if (!data.timerRunning && data.timerMode === "break") {
      data.timerRemaining = val * 60;
      el("timerText").textContent = formatTime(data.timerRemaining);
    }
  });
  el("breakMinInput").addEventListener("change", () => {
    saveUser();
    renderTimer();
  });

  el("targetSessionsInput").addEventListener("input", (e) => {
    const val = Math.max(1, parseInt(e.target.value) || 1);
    data.timerTargetSessions = val;
    const target = data.timerTargetSessions || 4;
    const today = data.sessionsToday || 0;
    el("sessionLabel").innerHTML = `Daily Goal: <strong style="font-size: 1.15em; color: var(--purple);">${today}</strong> of <strong>${target}</strong> completed`;
  });
  el("targetSessionsInput").addEventListener("change", () => {
    saveUser();
    renderTimer();
  });

  document.querySelectorAll(".stat-card[data-stat]").forEach((card) => {
    card.addEventListener("click", () => {
      const stat = card.dataset.stat;
      if (stat === "focusScore") {
        data.focusScore = Math.min(100, data.focusScore + 1);
        saveUser();
        renderStats();
      }
    });
  });

  el("studyGoalInput").addEventListener("change", () => {
    const hours = Number(el("studyGoalInput").value);
    data.studyGoal = Math.max(15, Math.round(hours * 60));
    saveUser();
    renderStats();
  });

  el("flashcardsGoalInput").addEventListener("change", () => {
    const val = parseInt(el("flashcardsGoalInput").value, 10);
    data.flashcardsGoal = Math.max(1, isNaN(val) ? 50 : val);
    saveUser();
    renderStats();
  });

  el("subjectList").addEventListener("input", (event) => {
    if (!event.target.matches("[data-subject]")) return;
    const index = Number(event.target.dataset.subject);
    data.subjects[index].value = Number(event.target.value);
    saveUser();
    renderSubjects();
  });

  el("subjectForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = el("subjectNameInput").value.trim();
    if (!name) return;
    const colors = ["purple", "mint", "amber", "red"];
    data.subjects.push({ name, value: 0, color: colors[data.subjects.length % colors.length] });
    el("subjectNameInput").value = "";
    saveUser();
    renderSubjects();
  });

  el("weeklyButton").addEventListener("click", () => {
    streakViewMode = "weekly";
    el("weeklyButton").classList.add("active");
    el("monthlyButton").classList.remove("active");
    renderStreak();
  });

  el("monthlyButton").addEventListener("click", () => {
    streakViewMode = "monthly";
    el("monthlyButton").classList.add("active");
    el("weeklyButton").classList.remove("active");
    renderStreak();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      syncTimerOnWake();
    }
  });

  el("taskList").addEventListener("change", async (event) => {
    if (!event.target.matches("[data-task]")) return;
    const taskIndex = Number(event.target.dataset.task);
    const task = data.tasks[taskIndex];
    if (!task) return;
    task.is_completed = event.target.checked;
    task.done = event.target.checked;
    saveUser();
    renderTasks();
    if (currentSupabaseUser) {
      await updateSupabaseTodo(task);
    }
  });

  el("taskList").addEventListener("click", async (event) => {
    if (!event.target.matches("[data-delete-task]")) return;
    const taskIndex = Number(event.target.dataset.deleteTask);
    const task = data.tasks[taskIndex];
    if (!task) return;
    data.tasks.splice(taskIndex, 1);
    saveUser();
    renderTasks();
    if (currentSupabaseUser) {
      await deleteSupabaseTodo(task);
    }
  });

  el("taskForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!currentSupabaseUser && !currentUser) {
      openAuthModal("Please log in to add and sync study tasks.");
      return;
    }
    const title = el("taskInput").value.trim();
    if (!title) return;
    const color = el("taskColorInput") ? el("taskColorInput").value : "#ff6e79";
    const tag = el("taskTagInput") ? el("taskTagInput").value : "Review";
    const todayStr = getLocalDateString();
    const newTask = {
      title,
      tag,
      done: false,
      is_completed: false,
      date: todayStr,
      color
    };
    data.tasks = data.tasks || [];
    data.tasks.push(newTask);
    el("taskInput").value = "";
    saveUser();
    renderTasks();

    if (currentSupabaseUser) {
      await addSupabaseTodo(newTask);
      renderTasks();
    }
  });

  el("timeButton").addEventListener("click", renderProgress);
  el("ankiFileInput").addEventListener("change", handleAnkiImport);

  const createDeckBtn = el("createDeckBtn");
  if (createDeckBtn) {
    createDeckBtn.addEventListener("click", () => {
      const name = prompt("Enter a name for the new deck:");
      if (!name) return;
      const deckName = name.trim();
      if (!deckName) return;

      data.flashcardDecks = data.flashcardDecks || {};
      if (data.flashcardDecks[deckName]) {
        alert(`A deck named "${deckName}" already exists.`);
        return;
      }

      data.flashcardDecks[deckName] = [];
      saveUser();
      saveFlashcardDecks();
      renderFlashcardsTab();
      alert(`Deck "${deckName}" created successfully!`);
    });
  }

  const closeDeckBtn = el("closeDeckBtn");
  if (closeDeckBtn) {
    closeDeckBtn.addEventListener("click", () => {
      currentStudyDeck = null;
      currentStudyCards = [];
      currentCardIndex = 0;
      cardFlipped = false;
      cardShownTime = null;
      renderFlashcardsTab();
    });
  }

  const sidebarToggleBtn = el("sidebarToggleBtn");
  if (sidebarToggleBtn) {
    sidebarToggleBtn.addEventListener("click", () => {
      data.flashcardSidebarCollapsed = !data.flashcardSidebarCollapsed;
      saveUser();
      updateSidebarUI();
    });
  }

  // Notes File Manager listeners
  el("personalNotesInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      alert("Please select a PDF file.");
      e.target.value = "";
      return;
    }

    const filename = file.name;
    const key = `notes:personal:${currentUser}:${filename}`;
    
    const exists = (data.notesList || []).some(n => n.filename === filename);
    if (exists) {
      if (!confirm(`A file named "${filename}" already exists. Do you want to overwrite it?`)) {
        e.target.value = "";
        return;
      }
    }

    try {
      await idb.set(key, file);
      
      if (!data.notesList) data.notesList = [];
      if (!exists) {
        data.notesList.push({
          filename: filename,
          size: file.size,
          timestamp: Date.now()
        });
      } else {
        const noteIdx = data.notesList.findIndex(n => n.filename === filename);
        if (noteIdx !== -1) {
          data.notesList[noteIdx].size = file.size;
          data.notesList[noteIdx].timestamp = Date.now();
        }
      }

      saveUser();
      renderFileReaderTab();
    } catch (err) {
      console.error("Failed to upload note:", err);
      alert("Error saving note: " + err.message);
    }
  });

  const hostNotesInput = el("hostNotesInput");
  if (hostNotesInput) {
    hostNotesInput.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
        alert("Please select a PDF file.");
        e.target.value = "";
        return;
      }

      const filename = file.name;
      const key = `notes:global:${filename}`;
      
      if (!confirm(`Do you want to upload "${filename}" as a shared reference for all users?`)) {
        e.target.value = "";
        return;
      }

      try {
        await idb.set(key, file);
        renderFileReaderTab();
      } catch (err) {
        console.error("Failed to upload shared note:", err);
        alert("Error saving shared note: " + err.message);
      }
    });
  }

  el("closeNoteBtn").addEventListener("click", closeActiveNote);

  const notesFocusToggleBtn = el("notesFocusToggleBtn");
  if (notesFocusToggleBtn) {
    notesFocusToggleBtn.addEventListener("click", () => {
      const layout = document.querySelector(".notes-layout");
      if (!layout) return;
      const isFocused = layout.classList.toggle("reader-focused");
      document.body.classList.toggle("notes-focus-active", isFocused);
      notesFocusToggleBtn.innerHTML = isFocused ? "✕ Exit Focus" : "⛶ Focus Mode";
      notesFocusToggleBtn.classList.toggle("active", isFocused);
      setTimeout(resizeCanvas, 300);
    });
  }

  // Dedicated Notes Tab listeners
  const createNoteBtn = el("createNewNoteBtn");
  if (createNoteBtn) {
    createNoteBtn.addEventListener("click", createNewIndependentNote);
  }

  const deleteNoteBtn = el("deleteActiveNoteBtn");
  if (deleteNoteBtn) {
    deleteNoteBtn.addEventListener("click", deleteActiveIndependentNote);
  }

  const titleInput = el("noteTitleInput");
  if (titleInput) {
    titleInput.addEventListener("input", saveActiveEditorNote);
  }

  let editorSaveTimeout = null;
  const contentTextarea = el("noteContentTextarea");
  if (contentTextarea) {
    contentTextarea.addEventListener("input", () => {
      if (editorSaveTimeout) clearTimeout(editorSaveTimeout);
      const status = el("editorSaveStatus");
      if (status) status.textContent = "Saving changes...";
      editorSaveTimeout = setTimeout(saveActiveEditorNote, 600);
    });
  }

  const previewBtn = el("toggleNotePreviewBtn");
  if (previewBtn) {
    previewBtn.addEventListener("click", () => {
      const previewPane = el("noteMarkdownPreview");
      const noteTextarea = el("noteContentTextarea");
      if (previewPane && noteTextarea) {
        const isPreviewHidden = previewPane.classList.toggle("hidden");
        noteTextarea.classList.toggle("hidden", !isPreviewHidden);
        
        if (!isPreviewHidden) {
          previewPane.innerHTML = parseMarkdown(noteTextarea.value);
          previewBtn.textContent = "✍ Edit";
        } else {
          previewBtn.textContent = "👁 Preview";
        }
      }
    });
  }

  const downloadBtn = el("downloadNoteBtn");
  if (downloadBtn) {
    downloadBtn.addEventListener("click", () => {
      const title = el("noteTitleInput").value || "note";
      const content = el("noteContentTextarea").value || "";
      const blob = new Blob([content], { type: "text/markdown;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", `${title.replace(/\s+/g, "_").toLowerCase()}.md`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    });
  }
}

bindEvents();
setAuthMode("login");

if (supabaseClient) {
  // Listen for Supabase auth state changes
  supabaseClient.auth.onAuthStateChange(async (event, session) => {
    if (session?.user) {
      login(session.user.email, session.user);
    } else if (event === "SIGNED_OUT") {
      logout();
    }
  });

  // Check active session on startup
  supabaseClient.auth.getSession().then(({ data: { session } }) => {
    if (session?.user) {
      login(session.user.email, session.user);
    } else if (currentUser && data) {
      login(currentUser);
    }
  }).catch(() => {
    if (currentUser && data) {
      login(currentUser);
    }
  });
} else if (currentUser && data) {
  login(currentUser);
}
