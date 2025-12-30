(() => {
  const DB_NAME = "trainingDB";
  const DB_VERSION = 2; // bump version (safe)

  const PROFILE_KEY = "training_profile_v1";
  const SAVE_GUARD_MS = 12000; // second click window for "suspicious reps" warning

  const EXERCISES = [
    { id: "legpress", name: "Leg Press" },
    { id: "goblet", name: "Goblet Squat" },
    { id: "latpulldown", name: "Lat Pulldown" },
    { id: "hyper", name: "Hyperextension" },
    { id: "dbbench", name: "DB Bench" },
    { id: "pushups", name: "Push-ups" },
    { id: "biceps", name: "Biceps Curl" },
    { id: "triceps", name: "Triceps Pushdown" },
    { id: "crunch", name: "Crunch" },
    { id: "plank", name: "Plank" },
  ];

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  let pendingSaveToken = null;
  let pendingSaveUntil = 0;

  function todayISO() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = () => {
        const db = req.result;

        if (!db.objectStoreNames.contains("workouts")) {
          const store = db.createObjectStore("workouts", { keyPath: "id", autoIncrement: true });
          store.createIndex("byDate", "date");
          store.createIndex("byCreatedAt", "createdAt");
        }

        if (!db.objectStoreNames.contains("lastValues")) {
          db.createObjectStore("lastValues", { keyPath: "exerciseId" });
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(db, storeName, mode = "readonly") {
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  async function getAllWorkouts(db) {
    return new Promise((resolve, reject) => {
      const store = tx(db, "workouts");
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveWorkoutToDB(db, workout) {
    return new Promise((resolve, reject) => {
      const store = tx(db, "workouts", "readwrite");
      const req = store.add(workout);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function bulkImportWorkouts(db, workouts) {
    return new Promise((resolve, reject) => {
      const store = tx(db, "workouts", "readwrite");
      let ok = 0;

      for (const w of workouts) {
        // Minimal schema normalize
        const doc = {
          date: String(w.date || "").slice(0, 10) || todayISO(),
          createdAt: typeof w.createdAt === "number" ? w.createdAt : Date.now(),
          entries: w.entries && typeof w.entries === "object" ? w.entries : {}
        };
        store.add(doc);
        ok++;
      }

      store.transaction.oncomplete = () => resolve(ok);
      store.transaction.onerror = () => reject(store.transaction.error);
    });
  }

  async function putLastValue(db, exerciseId, kg, reps, date) {
    return new Promise((resolve, reject) => {
      const store = tx(db, "lastValues", "readwrite");
      const req = store.put({ exerciseId, kg, reps, date, updatedAt: Date.now() });
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async function getLastValue(db, exerciseId) {
    return new Promise((resolve, reject) => {
      const store = tx(db, "lastValues");
      const req = store.get(exerciseId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  function readInputs() {
    const result = {};
    for (const ex of EXERCISES) {
      const kgEl = document.querySelector(`[data-ex="${ex.id}"][data-field="kg"]`);
      const repsEl = document.querySelector(`[data-ex="${ex.id}"][data-field="reps"]`);

      const kgRaw = (kgEl?.value ?? "").trim();
      const repsRaw = (repsEl?.value ?? "").trim();

      const kg = kgRaw === "" ? null : Number(kgRaw);
      const reps = repsRaw === "" ? null : Number(repsRaw);

      result[ex.id] = { kg, reps };
    }
    return result;
  }

  function fillInputs(valuesMap) {
    for (const ex of EXERCISES) {
      const kgEl = document.querySelector(`[data-ex="${ex.id}"][data-field="kg"]`);
      const repsEl = document.querySelector(`[data-ex="${ex.id}"][data-field="reps"]`);
      const v = valuesMap[ex.id];
      if (!kgEl || !repsEl || !v) continue;

      kgEl.value = v.kg ?? "";
      repsEl.value = v.reps ?? "";
    }
  }

  function clearInputs() {
    $$(`[data-field="kg"], [data-field="reps"]`).forEach((el) => (el.value = ""));
  }

  function setStatus(msg, danger = false) {
    const el = $("#statusMsg");
    if (!el) return;
    el.textContent = msg || "";
    el.style.color = danger ? "var(--danger)" : "var(--muted)";
  }

  function downloadFile(filename, mime, text) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function recommendNext(exId, lastKg, lastReps) {
    // If we don't have both values, we can still show last, but no recommendation
    if (lastKg == null || Number.isNaN(lastKg)) return null;

    const isMachine = ["legpress", "latpulldown", "triceps"].includes(exId);
    const isDumbbell = ["biceps", "dbbench", "goblet"].includes(exId);

    // Plank: lastKg is seconds, lastReps is sets
    if (exId === "plank") {
      const sec = lastKg;
      const nextSec = sec >= 40 ? sec + 10 : sec + 5;
      return { display: `${nextSec} сек`, kg: nextSec, reps: lastReps ?? 2, kind: "time" };
    }

    // Push-ups: weight is usually 0, reps is reps
    if (exId === "pushups") {
      if (lastReps == null || Number.isNaN(lastReps)) return { display: `+0 кг × 8–12`, kg: 0, reps: "8–12", kind: "bw" };
      const nextReps = lastReps >= 12 ? lastReps + 2 : lastReps;
      return { display: `0 кг × ${nextReps}`, kg: 0, reps: nextReps, kind: "bw" };
    }

    // If reps missing → recommend based on weight only
    if (lastReps == null || Number.isNaN(lastReps)) {
      return { display: `${lastKg} кг × 8–12`, kg: lastKg, reps: "8–12", kind: "weight" };
    }

    let inc = 0;
    if (lastReps >= 8 && lastReps <= 12) {
      inc = isMachine ? 2.5 : isDumbbell ? 1 : 1;
    } else if (lastReps > 12) {
      inc = isMachine ? 5 : isDumbbell ? 2 : 1;
    } else {
      inc = 0; // reps < 8 → keep same weight
    }

    const nextKg = Math.round((lastKg + inc) * 10) / 10;
    return { display: `${nextKg} кг × 8–12`, kg: nextKg, reps: "8–12", kind: "weight" };
  }

  function defaultRecommendationDisplay(exId) {
    const defaults = {
      legpress: "50 кг × 8–12",
      goblet: "8 кг × 8–12",
      latpulldown: "30 кг × 8–12",
      hyper: "вес тела × 12",
      dbbench: "8 кг × 8–12",
      pushups: "0 кг × 8–12",
      biceps: "6 кг × 8–12",
      triceps: "20 кг × 8–12",
      crunch: "вес тела × 15",
      plank: "30–40 сек",
    };
    return defaults[exId] || "—";
  }

  function startOfWeek(d) {
    const date = new Date(d);
    const day = (date.getDay() + 6) % 7; // Mon=0
    date.setHours(0,0,0,0);
    date.setDate(date.getDate() - day);
    return date;
  }

  function workoutsThisWeek(workouts) {
    const now = new Date();
    const start = startOfWeek(now);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);

    let count = 0;
    for (const w of workouts) {
      const d = new Date(w.date + "T00:00:00");
      if (d >= start && d < end) count++;
    }
    return count;
  }

  function trainingStreak48h(workouts) {
    if (!workouts.length) return 0;

    // Unique dates, sorted desc
    const dates = Array.from(new Set(workouts.map(w => w.date))).sort((a,b) => b.localeCompare(a));
    let streak = 1;

    // Start from most recent workout day
    let prev = new Date(dates[0] + "T00:00:00");

    for (let i = 1; i < dates.length; i++) {
      const cur = new Date(dates[i] + "T00:00:00");

      // gap in hours between workout days
      const diffHours = (prev - cur) / (1000 * 60 * 60);

      // Allow up to 48h gap (2 days) between workouts
      if (diffHours <= 48 + 0.01 && diffHours >= 0) {
        streak++;
        prev = cur;
      } else {
        break;
      }
    }
    return streak;
  }

  function legpressDelta30(workouts) {
    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - 30);

    const sorted = [...workouts].sort((a,b) => a.date.localeCompare(b.date)); // asc
    let before = null;
    let latest = null;

    for (const w of sorted) {
      const kg = w.entries?.legpress?.kg ?? null;
      if (kg == null || Number.isNaN(kg)) continue;

      latest = kg;
      const d = new Date(w.date + "T00:00:00");
      if (d <= cutoff) before = kg;
    }

    if (latest == null || before == null) return 0;
    return Math.round((latest - before) * 10) / 10;
  }

  function buildHistoryPreview(entries) {
    // show up to 3 exercises that have values
    const lines = [];
    for (const ex of EXERCISES) {
      const v = entries?.[ex.id];
      if (!v) continue;
      const has = (v.kg != null && !Number.isNaN(v.kg)) || (v.reps != null && !Number.isNaN(v.reps));
      if (!has) continue;

      const kg = (v.kg ?? "");
      const reps = (v.reps ?? "");
      // compact format
      if (kg !== "" && reps !== "") lines.push(`${ex.id}: ${kg}×${reps}`);
      else if (kg !== "") lines.push(`${ex.id}: ${kg}`);
      else lines.push(`${ex.id}: ${reps}`);
      if (lines.length >= 3) break;
    }
    return lines.length ? lines.join(" • ") : "—";
  }

  function renderHistory(workouts) {
    const list = $("#historyList");
    if (!list) return;
    list.innerHTML = "";

    const sorted = [...workouts].sort((a,b) => b.date.localeCompare(a.date) || (b.createdAt - a.createdAt));

    if (!sorted.length) {
      list.innerHTML = `<div class="history-item"><strong>Пока пусто</strong><span>Сохрани первую тренировку выше.</span></div>`;
      return;
    }

    for (const w of sorted.slice(0, 60)) {
      const item = document.createElement("div");
      item.className = "history-item";
      const preview = buildHistoryPreview(w.entries);
      item.innerHTML = `
        <strong>${w.date} — Full Body</strong>
        <span>Нажми, чтобы загрузить</span>
        <div class="history-preview">${preview}</div>
      `;

      item.addEventListener("click", () => {
        fillInputs(w.entries || {});
        $("#workoutDate").value = w.date;
        setStatus(`Загружено: ${w.date}`);
        window.scrollTo({ top: 0, behavior: "smooth" });
      });

      list.appendChild(item);
    }
  }

  async function fillLastHints(db) {
    const hintMap = {
      legpress: "#hint-legpress",
      goblet: "#hint-goblet",
      latpulldown: "#hint-latpulldown",
      hyper: "#hint-hyper",
      dbbench: "#hint-dbbench",
      pushups: "#hint-pushups",
      biceps: "#hint-biceps",
      triceps: "#hint-triceps",
      crunch: "#hint-crunch",
      plank: "#hint-plank",
    };

    for (const ex of EXERCISES) {
      const last = await getLastValue(db, ex.id);
      const el = document.querySelector(hintMap[ex.id]);
      if (!el) continue;

      if (!last) {
        const fallback = defaultRecommendationDisplay(ex.id);
        el.textContent = `Последний раз: — · Рекомендация: ${fallback}`;
      }
      if (!last) continue;

      // Build "last time" string
      if (ex.id === "plank") {
        const sec = last.kg ?? "—";
        const sets = last.reps ?? "—";
        const rec = recommendNext(ex.id, last.kg, last.reps);
        el.textContent = `Последний раз: ${sec} сек (sets ${sets}) · Рекомендация: ${rec ? rec.display : "—"}`;
        continue;
      }

      if (ex.id === "pushups") {
        const reps = last.reps ?? "—";
        const rec = recommendNext(ex.id, last.kg ?? 0, last.reps);
        el.textContent = `Последний раз: 0 кг × ${reps} · Рекомендация: ${rec ? rec.display : "—"}`;
        continue;
      }

      // Normal exercises
      const kg = last.kg ?? "—";
      const reps = last.reps ?? "—";
      const rec = recommendNext(ex.id, last.kg, last.reps);

      // "Последний раз: 10 кг × 10 · Рекомендация: 11 кг × 8–12"
      el.textContent = `Последний раз: ${kg} кг × ${reps} · Рекомендация: ${rec ? rec.display : "—"}`;
    }
  }

  async function autoFillFromLast(db) {
    const entries = {};
    for (const ex of EXERCISES) {
      const last = await getLastValue(db, ex.id);
      if (last) entries[ex.id] = { kg: last.kg ?? null, reps: last.reps ?? null };
    }

    for (const ex of EXERCISES) {
      const kgEl = document.querySelector(`[data-ex="${ex.id}"][data-field="kg"]`);
      const repsEl = document.querySelector(`[data-ex="${ex.id}"][data-field="reps"]`);
      if (!kgEl || !repsEl) continue;

      const curKg = (kgEl.value ?? "").trim();
      const curReps = (repsEl.value ?? "").trim();

      if (curKg === "" && entries[ex.id]?.kg != null) kgEl.value = entries[ex.id].kg;
      if (curReps === "" && entries[ex.id]?.reps != null) repsEl.value = entries[ex.id].reps;
    }
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  function loadProfile() {
    try {
      const raw = localStorage.getItem(PROFILE_KEY);
      if (!raw) return { height: 180, weight: 76 };
      const p = JSON.parse(raw);
      return {
        height: Number(p.height) || 180,
        weight: Number(p.weight) || 76,
      };
    } catch {
      return { height: 180, weight: 76 };
    }
  }

  function saveProfile(p) {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
  }

  function applyProfileToUI(p) {
    $("#profileHeight").value = p.height;
    $("#profileWeight").value = p.weight;
    const chip = $("#chipProfile");
    if (chip) chip.textContent = `Рост ${p.height} / Вес ${p.weight}`;
  }

  function findSuspiciousReps(entries) {
    // Very basic heuristic: reps < 3 or reps > 30 (ignore plank which uses "sets" in reps field)
    const bad = [];
    for (const ex of EXERCISES) {
      const v = entries[ex.id];
      if (!v) continue;
      if (ex.id === "plank") continue;
      const reps = v.reps;
      if (reps == null || Number.isNaN(reps)) continue;
      if (reps < 3 || reps > 30) bad.push(`${ex.id} reps=${reps}`);
    }
    return bad;
  }

  function sameToken(a, b) {
    return a && b && a === b;
  }

  async function main() {
    const db = await openDB();

    // profile
    const profile = loadProfile();
    applyProfileToUI(profile);

    $("#saveProfile")?.addEventListener("click", () => {
      const height = Number(($("#profileHeight").value || "").trim());
      const weight = Number(($("#profileWeight").value || "").trim());
      const p = {
        height: Number.isFinite(height) && height > 100 && height < 250 ? height : profile.height,
        weight: Number.isFinite(weight) && weight > 30 && weight < 250 ? weight : profile.weight,
      };
      saveProfile(p);
      applyProfileToUI(p);
      setStatus("Профиль сохранён.");
    });

    // init date field
    const dateEl = $("#workoutDate");
    if (dateEl && !dateEl.value) dateEl.value = todayISO();

    // first fill hints + autofill
    await fillLastHints(db);
    await autoFillFromLast(db);

    const workouts = await getAllWorkouts(db);
    $("#kpiWeek").textContent = String(workoutsThisWeek(workouts));
    $("#kpiStreak").textContent = String(trainingStreak48h(workouts));
    $("#kpiLegpress30").textContent = String(legpressDelta30(workouts));
    renderHistory(workouts);

    $("#clearToday")?.addEventListener("click", () => {
      clearInputs();
      setStatus("Поля очищены.");
    });

    // import JSON
    $("#importJsonBtn")?.addEventListener("click", () => {
      $("#importJsonFile").click();
    });

    $("#importJsonFile")?.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!Array.isArray(data)) {
          setStatus("Import: JSON должен быть массивом тренировок.", true);
          return;
        }

        const added = await bulkImportWorkouts(db, data);

        // refresh UI
        const all = await getAllWorkouts(db);
        $("#kpiWeek").textContent = String(workoutsThisWeek(all));
        $("#kpiStreak").textContent = String(trainingStreak48h(all));
        $("#kpiLegpress30").textContent = String(legpressDelta30(all));
        renderHistory(all);

        setStatus(`✅ Import OK: добавлено ${added} тренировок`);
      } catch (err) {
        console.error(err);
        setStatus("Import: ошибка чтения JSON.", true);
      } finally {
        e.target.value = "";
      }
    });

    $("#saveWorkout")?.addEventListener("click", async () => {
      const date = ($("#workoutDate")?.value || todayISO()).trim();
      const entries = readInputs();

      // require at least 1 filled exercise
      const hasAny = Object.values(entries).some(v =>
        (v.kg != null && !Number.isNaN(v.kg)) || (v.reps != null && !Number.isNaN(v.reps))
      );
      if (!hasAny) {
        setStatus("Заполни хотя бы одно упражнение (кг или reps) перед сохранением.", true);
        return;
      }

      // reps sanity check
      const suspicious = findSuspiciousReps(entries);
      const token = JSON.stringify({ date, suspicious });

      const now = Date.now();
      const isSecondClick = sameToken(pendingSaveToken, token) && now < pendingSaveUntil;

      if (suspicious.length && !isSecondClick) {
        pendingSaveToken = token;
        pendingSaveUntil = now + SAVE_GUARD_MS;
        setStatus(`⚠️ Подозрительные reps: ${suspicious.join(", ")}. Если ок — нажми "Сохранить" ещё раз.`, true);
        return;
      }

      pendingSaveToken = null;
      pendingSaveUntil = 0;

      const workout = { date, createdAt: Date.now(), entries };
      await saveWorkoutToDB(db, workout);

      // update lastValues for filled entries
      for (const ex of EXERCISES) {
        const v = entries[ex.id];
        if (!v) continue;
        const filled = (v.kg != null && !Number.isNaN(v.kg)) || (v.reps != null && !Number.isNaN(v.reps));
        if (!filled) continue;
        await putLastValue(db, ex.id, v.kg, v.reps, date);
      }

      setStatus("✅ Сохранено офлайн!");
      await fillLastHints(db);

      const all = await getAllWorkouts(db);
      $("#kpiWeek").textContent = String(workoutsThisWeek(all));
      $("#kpiStreak").textContent = String(trainingStreak48h(all));
      $("#kpiLegpress30").textContent = String(legpressDelta30(all));
      renderHistory(all);
    });

    $("#exportJson")?.addEventListener("click", async () => {
      const all = await getAllWorkouts(db);
      downloadFile(`workouts_${todayISO()}.json`, "application/json", JSON.stringify(all, null, 2));
    });

    $("#exportCsv")?.addEventListener("click", async () => {
      const all = await getAllWorkouts(db);

      const header = ["date","exercise","kg","reps"];
      const rows = [header.join(",")];

      for (const w of all.sort((a,b)=>a.date.localeCompare(b.date))) {
        for (const ex of EXERCISES) {
          const v = w.entries?.[ex.id] || {};
          const kg = (v.kg ?? "");
          const reps = (v.reps ?? "");
          if (kg === "" && reps === "") continue;
          rows.push([w.date, ex.id, kg, reps].join(","));
        }
      }

      downloadFile(`workouts_${todayISO()}.csv`, "text/csv", rows.join("\n"));
    });

    $("#openGallery")?.addEventListener("click", () => {
      const section = document.querySelector("#techGallery");
      if (section) section.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    registerServiceWorker();
  }

  main().catch((e) => {
    console.error(e);
    setStatus("Ошибка IndexedDB. Попробуй другой браузер/очистить данные сайта.", true);
  });
})();
