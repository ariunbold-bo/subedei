import {
  ATTENDANCE_LABELS,
  CALL_LABELS,
  PICKUP_LABELS,
  PICKUP_TONE,
  PURPOSE_LABELS,
  SMS_PURPOSE_LABELS,
  api,
  formatDateTime,
  formatTime,
  html,
  listen,
  modelLabel,
  raw,
  toast,
} from "./common.js";

const state = { status: null, today: null, calls: [], sms: [], meetings: [], guardians: [], tab: "today" };
const $ = (selector) => document.querySelector(selector);

// ---- Tabs --------------------------------------------------------------
document.querySelectorAll("[data-tab]").forEach((button) =>
  button.addEventListener("click", () => showTab(button.dataset.tab)),
);

const showTab = (tab) => {
  state.tab = tab;
  document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  document.querySelectorAll("[data-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== tab));
  try {
    localStorage.setItem("subedei.tab", tab);
  } catch {}
  refresh();
};

// ---- Data --------------------------------------------------------------
const loadStatus = async () => {
  state.status = await api("/status");
  renderChips();
};

const refresh = async ({ auto = false } = {}) => {
  // Live updates must not wipe roster fields the teacher is still editing.
  if (auto && state.tab === "roster" && state.rosterDirty) return;
  try {
    if (state.tab === "roster") {
      state.roster = await api("/roster");
      state.rosterDirty = false;
      renderRoster();
    } else if (state.tab === "today") {
      state.today = await api("/today");
      renderToday();
    } else if (state.tab === "calls") {
      state.calls = await api("/calls?limit=60");
      if (!state.today) state.today = await api("/today");
      renderCalls();
    } else if (state.tab === "sms") {
      [state.sms, state.today, state.guardians] = await Promise.all([api("/sms"), api("/today"), api("/guardians")]);
      renderRecipients();
      renderSmsHistory();
    } else if (state.tab === "meetings") {
      [state.meetings, state.guardians, state.today] = await Promise.all([api("/meetings"), api("/guardians"), api("/today")]);
      renderMeetings();
    } else if (state.tab === "settings") {
      state.today = await api("/today");
      renderSettings();
    }
  } catch (error) {
    toast(error.message, "danger");
  }
};

let refreshTimer;
const scheduleRefresh = () => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh({ auto: true }), 250);
};

// ---- Header ------------------------------------------------------------
const renderChips = () => {
  const s = state.status;
  if (!s) return;
  $("#school-line").textContent = `${s.school} · Багшийн автомат туслах`;
  const llmOn = s.llm.reachable && s.llm.modelFound;
  const chips = [
    [`AI: ${modelLabel(s.llm.model)}`, llmOn ? "true" : s.llm.reachable ? "warn" : "false", llmOn ? `${s.llm.model} ажиллаж байна` : "AI холбогдоогүй — дүрмийн задлагч ажиллана"],
    [`TTS: ${s.speech.tts === "oyu" ? "Oyu" : "browser"}`, s.speech.tts === "oyu" ? "true" : "warn", "Монгол яриа үүсгэгч"],
    [`STT: ${s.speech.stt === "oyu" ? "Oyu" : "browser"}`, s.speech.stt === "oyu" ? "true" : "warn", "Яриа танигч"],
    [
      `Утас: ${s.calls.provider === "twilio" ? "Twilio" : "симулятор"}`,
      s.calls.provider === "twilio" ? "true" : "warn",
      s.calls.provider === "twilio" ? `Жинхэнэ утас руу ${s.calls.from}-оос залгана` : s.calls.problems.join("; ") || "Browser утасны симулятор",
    ],
    [`SMS:${s.sms.provider === "http" ? "gateway" : "simulator"}`, s.sms.provider === "http" ? "true" : "warn", "SMS илгээгч"],
    [`erxes: ${s.erxes.enabled ? "холбогдсон" : "standalone"}`, s.erxes.enabled ? "true" : "warn", "erxes gateway + Contacts"],
  ];
  $("#chips").innerHTML = chips
    .map(([label, on, title]) => html`<span class="chip" data-on="${on}" title="${title}">${label}</span>`)
    .join("");
};

// ---- Today -------------------------------------------------------------
const renderToday = () => {
  const { counts, rows, classrooms, date } = state.today;
  const classroom = classrooms[0];
  $("#today-title").textContent = `${classroom ? `${classroom.name} анги · ` : ""}${date}${classroom ? ` · тарах ${classroom.pickupTime}` : ""}`;

  const waiting = counts.waiting + counts.contacting + counts.coming;
  const kpis = [
    ["Нийт", counts.total],
    ["Ирсэн", counts.present + counts.late, "ok"],
    ["Тасалсан", counts.absent + counts.excused, counts.absent ? "danger" : undefined],
    ["Бүртгээгүй", counts.unknown],
    ["Авсан", counts.pickedUp, "ok"],
    ["Хүлээгдэж буй", waiting, waiting ? "info" : undefined],
    ["Холбогдсонгүй", counts.unreachable, counts.unreachable ? "danger" : undefined],
  ];
  $("#kpis").innerHTML = kpis
    .map(([label, value, tone]) => html`<div class="kpi" data-tone="${tone ?? ""}"><b>${value}</b><span>${label}</span></div>`)
    .join("");

  $("#students").innerHTML = rows.length
    ? rows.map(studentRow).join("")
    : `<tr><td colspan="5" class="empty">Сурагч алга. Тохиргоо табаас нэмнэ үү.</td></tr>`;
};

const studentRow = ({ student, guardians, record, lastCall }) => {
  const present = record.attendance === "present" || record.attendance === "late";
  const pickup = record.pickup ?? { status: "waiting" };
  const tone = PICKUP_TONE[pickup.status] ?? "muted";
  const live = pickup.status === "contacting";
  const eta = pickup.expectedAt ? ` · ${formatTime(pickup.expectedAt)} орчим` : "";

  const attendanceButtons = ["present", "absent", "late", "excused"]
    .map(
      (status) =>
        html`<button data-attendance="${status}" data-student="${student._id}" aria-pressed="${record.attendance === status}">${ATTENDANCE_LABELS[status]}</button>`,
    )
    .join("");

  const pickupCell = present
    ? html`<span class="badge ${live ? "pulse" : ""}" data-tone="${tone}">${PICKUP_LABELS[pickup.status] ?? pickup.status}</span>
        ${raw(pickup.note ? html`<div class="sub">${pickup.note}${eta}</div>` : eta ? html`<div class="sub">${eta}</div>` : "")}
        ${raw(pickup.pickedUpAt ? html`<div class="sub">${formatTime(pickup.pickedUpAt)}${pickup.pickedUpBy ? ` · ${pickup.pickedUpBy}` : ""}</div>` : "")}`
    : html`<span class="sub">${record.attendanceNote || "—"}</span>`;

  const callCell = lastCall
    ? html`<span class="badge" data-tone="${lastCall.status === "completed" ? "ok" : lastCall.status === "ringing" || lastCall.status === "answered" ? "info" : "warn"}">${CALL_LABELS[lastCall.status]}</span>
        <div class="sub">${PURPOSE_LABELS[lastCall.purpose]} · ${formatTime(lastCall.ringingAt)} · ${guardianName(guardians, lastCall.guardianId)}</div>
        ${raw(lastCall.intent?.summary ? html`<div class="sub">“${lastCall.intent.summary}”</div>` : "")}`
    : `<span class="sub">—</span>`;

  const actions = [];
  if (present && pickup.status !== "picked_up") {
    actions.push(html`<button class="btn small primary" data-picked="${student._id}">Авсан</button>`);
    actions.push(html`<button class="btn small" data-call="late_pickup" data-student="${student._id}">📞 Залгах</button>`);
  }
  if (present && pickup.status === "picked_up") {
    actions.push(html`<button class="btn small" data-pickup-reset="${student._id}">Буцаах</button>`);
  }
  if (record.attendance === "absent") {
    actions.push(html`<button class="btn small" data-call="absence" data-student="${student._id}">📞 Шалтгаан асуух</button>`);
  }

  return html`<tr>
    <td><div class="name">${student.firstName} ${student.lastName}</div>
      <div class="sub">${guardians.map((g) => `${g.relation} ${g.phone}`).join(" · ")}</div></td>
    <td><div class="seg">${raw(attendanceButtons)}</div></td>
    <td>${raw(pickupCell)}</td>
    <td class="hide-sm">${raw(callCell)}</td>
    <td><div class="actions">${raw(actions.join(""))}</div></td>
  </tr>`;
};

const guardianName = (guardians, id) => {
  const g = guardians.find((x) => x._id === id);
  return g ? `${g.relation} (${g.name})` : "";
};

// ---- Calls -------------------------------------------------------------
const renderCalls = () => {
  const students = new Map((state.today?.rows ?? []).map((r) => [r.student._id, r]));
  $("#calls").innerHTML = state.calls.length
    ? state.calls
        .map((call) => {
          const row = students.get(call.studentId);
          const guardian = row?.guardians.find((g) => g._id === call.guardianId);
          const intent = call.intent;
          return html`<div class="item">
            <div class="item-head">
              <span class="badge" data-tone="${call.status === "completed" ? "ok" : ["ringing", "answered"].includes(call.status) ? "info" : "warn"}">${CALL_LABELS[call.status]}</span>
              <b>${row ? row.student.firstName : "Хурал"}</b>
              <span class="sub">${PURPOSE_LABELS[call.purpose]} · ${guardian ? `${guardian.relation} ${guardian.name} ${guardian.phone}` : ""} · ${formatDateTime(call.ringingAt)} · ${call.attempt}-р оролдлого</span>
            </div>
            <div class="sub">🔊 ${call.script}</div>
            ${raw(call.transcript ? html`<div class="quote">🗣️ “${call.transcript}”</div>` : "")}
            ${raw(
              intent
                ? html`<div class="item-head" style="margin-top: 6px"><span class="badge ${intent.engine === "llm" ? "ai" : ""}">${intent.engine === "llm" ? modelLabel(intent.model) : "Дүрэм"}</span><span>${intent.summary ?? ""}</span></div>`
                : "",
            )}
            ${raw(call.recordingUrl ? html`<audio controls preload="none" src="${call.recordingUrl}"></audio>` : "")}
          </div>`;
        })
        .join("")
    : `<div class="empty">Одоогоор дуудлага алга.</div>`;
};

// ---- SMS ---------------------------------------------------------------
const selected = new Set();

const renderRecipients = () => {
  const rows = state.today?.rows ?? [];
  $("#recipients").innerHTML = rows
    .flatMap(({ student, guardians }) =>
      guardians.map(
        (g) =>
          html`<label><input type="checkbox" data-guardian="${g._id}" ${raw(selected.has(g._id) ? "checked" : "")} />
          <span><b>${student.firstName}</b> — ${g.relation} ${g.name} <span class="sub">${g.phone}</span></span></label>`,
      ),
    )
    .join("");
  updateSmsCounter();
};

const updateSmsCounter = () => {
  $("#sms-count").textContent = $("#sms-text").value.length;
  $("#sms-selected").textContent = selected.size;
};

document.addEventListener("change", (event) => {
  const id = event.target.dataset?.guardian;
  if (!id) return;
  if (event.target.checked) selected.add(id);
  else selected.delete(id);
  updateSmsCounter();
});

$("#sms-text").addEventListener("input", updateSmsCounter);

document.querySelectorAll("[data-select]").forEach((button) =>
  button.addEventListener("click", () => {
    const rows = state.today?.rows ?? [];
    const mode = button.dataset.select;
    selected.clear();
    for (const { guardians, record } of rows) {
      const present = record.attendance === "present" || record.attendance === "late";
      const include =
        mode === "all"
          ? guardians
          : mode === "primary"
            ? guardians.slice(0, 1)
            : mode === "waiting"
              ? present && record.pickup?.status !== "picked_up"
                ? guardians
                : []
              : mode === "absent"
                ? record.attendance === "absent" || record.attendance === "excused"
                  ? guardians
                  : []
                : [];
      include.forEach((g) => selected.add(g._id));
    }
    renderRecipients();
  }),
);

const renderSmsHistory = () => {
  const names = new Map(state.guardians.map((g) => [g._id, `${g.relation} ${g.name}`]));
  $("#sms-history").innerHTML = state.sms.length
    ? state.sms
        .map(
          (m) => html`<div class="item">
          <div class="item-head">
            <span class="badge" data-tone="${m.direction === "inbound" ? "info" : m.status === "failed" ? "danger" : "ok"}">${m.direction === "inbound" ? "← Ирсэн" : m.status === "simulated" ? "Симулятор" : m.status === "failed" ? "Алдаа" : "Илгээсэн"}</span>
            <b>${names.get(m.guardianId) ?? m.phone}</b>
            <span class="sub">${m.phone} · ${SMS_PURPOSE_LABELS[m.purpose] ?? m.purpose} · ${formatDateTime(m.createdAt)}</span>
          </div>
          <div>${m.text}</div>
          ${raw(m.sentText && m.sentText !== m.text ? html`<div class="sub">Latin: ${m.sentText}</div>` : "")}
          ${raw(m.error ? html`<div class="sub" style="color: var(--danger)">${m.error}</div>` : "")}
        </div>`,
        )
        .join("")
    : `<div class="empty">SMS алга.</div>`;
};

// ---- Meetings ----------------------------------------------------------
const renderMeetings = () => {
  const names = new Map(state.guardians.map((g) => [g._id, `${g.relation} ${g.name}`]));
  $("#meetings").innerHTML = state.meetings.length
    ? state.meetings
        .map((m) => {
          const yes = m.rsvps.filter((r) => r.response === "yes");
          const no = m.rsvps.filter((r) => r.response === "no");
          const pending = m.guardianIds.length - yes.length - no.length;
          return html`<div class="item">
            <div class="item-head"><b>${m.title}</b><span class="sub">${formatDateTime(m.startsAt)}${m.location ? ` · ${m.location}` : ""}</span></div>
            ${raw(m.note ? html`<div class="sub">${m.note}</div>` : "")}
            <div class="item-head" style="margin-top: 8px">
              <span class="badge" data-tone="ok">Ирнэ: ${yes.length}</span>
              <span class="badge" data-tone="danger">Ирэхгүй: ${no.length}</span>
              <span class="badge">Хариугүй: ${pending}</span>
            </div>
            <div class="sub">${m.reminders.map((r) => `${r.label ?? ""} ${r.sentAt ? "✓ илгээсэн" : `· ${formatDateTime(r.at)}`}`).join(" | ")}</div>
            ${raw(yes.length || no.length ? html`<div class="sub">${[...yes.map((r) => `✓ ${names.get(r.guardianId) ?? ""}`), ...no.map((r) => `✗ ${names.get(r.guardianId) ?? ""}`)].join(", ")}</div>` : "")}
            <div class="actions" style="margin-top: 8px">
              <button class="btn small" data-meeting-remind="${m._id}">📨 Одоо SMS сануулах</button>
              <button class="btn small" data-meeting-call="${m._id}">📞 Хариу өгөөгүйд залгах</button>
            </div>
          </div>`;
        })
        .join("")
    : `<div class="empty">Хурал алга.</div>`;
};

const defaultMeetingTime = () => {
  const d = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  d.setHours(18, 0, 0, 0);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T18:00`;
};
$("#m-start").value = defaultMeetingTime();

$("#meeting-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const guardianIds = (state.today?.rows ?? []).map((r) => r.guardians[0]?._id).filter(Boolean);
  const remindMinutesBefore = [...document.querySelectorAll('[name="m-remind"]:checked')].map((i) => Number(i.value));
  try {
    await api("/meetings", {
      method: "POST",
      body: {
        title: $("#m-title").value,
        startsAt: new Date($("#m-start").value).toISOString(),
        location: $("#m-location").value,
        note: $("#m-note").value,
        guardianIds,
        remindMinutesBefore,
      },
    });
    toast("Хурал үүсгэлээ. Сануулга автоматаар очно.");
    refresh();
  } catch (error) {
    toast(error.message, "danger");
  }
});

// ---- Settings ----------------------------------------------------------
const renderSettings = () => {
  const classroom = state.today?.classrooms[0];
  if (classroom) {
    $("#c-name").value = classroom.name;
    $("#c-teacher").value = classroom.teacherName ?? "";
    $("#c-phone").value = classroom.teacherPhone ?? "";
    $("#c-start").value = classroom.classStartTime ?? "08:00";
    $("#c-pickup").value = classroom.pickupTime ?? "17:00";
  }
  const s = state.status;
  if (s) {
    $("#pickup-hint").textContent = s.autoPickupCalls
      ? `Тарах цагаас ${s.pickupGraceMin} минутын дараа аваагүй хүүхдийн эцэг эх рүү автоматаар залгана. Утсаа ${s.ringTimeoutSec} секундэд авахгүй бол дараагийн хүн рүү, хэн ч авахгүй бол SMS.`
      : "Автомат залгалт унтраастай (AUTO_PICKUP_CALLS=false).";
    $("#erxes-hint").textContent = s.erxes.enabled
      ? `Gateway-д бүртгэгдсэн. Эцэг эх erxes Contacts-д харилцагчаар үүснэ${s.erxes.notes ? ", дуудлага/SMS бүр timeline-д тэмдэглэл болно" : " (тэмдэглэл бичихэд ERXES_USER_ID хэрэгтэй)"}.`
      : "Standalone горим. ERXES_ENABLED=true болгож erxes-ийн Redis-тэй холбоно уу.";
    $("#system-info").innerHTML = html`AI: ${s.llm.model} @ ${s.llm.reachable ? "холбогдсон" : "холбогдоогүй"}${s.llm.reachable && !s.llm.modelFound ? " (model татаагүй)" : ""}<br />
      TTS: ${s.speech.tts} · STT: ${s.speech.stt} · SMS: ${s.sms.provider}${s.sms.latin ? " (latin)" : ""}<br />
      Цагийн бүс: ${s.timezone} · v${s.version}`;
  }
};

$("#class-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const classroom = state.today?.classrooms[0];
  if (!classroom) return;
  try {
    await api(`/classrooms/${classroom._id}`, {
      method: "PATCH",
      body: {
        name: $("#c-name").value,
        teacherName: $("#c-teacher").value,
        teacherPhone: $("#c-phone").value,
        classStartTime: $("#c-start").value,
        pickupTime: $("#c-pickup").value,
      },
    });
    toast("Хадгаллаа");
    refresh();
  } catch (error) {
    toast(error.message, "danger");
  }
});

const guardianRow = (relation = "ээж") => {
  const div = document.createElement("div");
  div.className = "form-row";
  div.dataset.guardianRow = "";
  div.innerHTML = html`<div><label>Хэн</label><input name="relation" value="${relation}" required /></div>
    <div><label>Нэр</label><input name="name" placeholder="Г. Сарантуяа" /></div>
    <div><label>Утас</label><input name="phone" inputmode="tel" placeholder="99112233" /></div>`;
  return div;
};
const resetGuardianRows = () => $("#s-guardians").replaceChildren(guardianRow("ээж"), guardianRow("аав"));
resetGuardianRows();

/** Reads {relation, name, phone} from a row of inputs. */
const readGuardian = (row) => ({
  relation: row.querySelector('[name="relation"]').value.trim(),
  name: row.querySelector('[name="name"]').value.trim(),
  phone: row.querySelector('[name="phone"]').value.trim(),
});

$("#student-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const guardians = [...document.querySelectorAll("[data-guardian-row]")].map(readGuardian).filter((g) => g.name || g.phone);
  try {
    await api("/students", { method: "POST", body: { firstName: $("#s-first").value, lastName: $("#s-last").value, guardians } });
    toast(`${$("#s-first").value} нэмэгдлээ`);
    event.target.reset();
    resetGuardianRows();
    $("#s-first").focus();
    refresh();
  } catch (error) {
    toast(error.message, "danger");
  }
});

$("#import-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  await withBusy(button, async () => {
    const r = await api("/roster/import", { method: "POST", body: { text: $("#import-text").value } });
    $("#import-result").textContent =
      `✓ ${r.studentsCreated} шинэ сурагч, ${r.guardiansAdded} асран хамгаалагч нэмэгдлээ.` +
      (r.errors.length ? `\n⚠ ${r.errors.length} мөр алдаатай:\n${r.errors.map((e) => `  ${e.line}-р мөр: ${e.error}`).join("\n")}` : "");
    if (!r.errors.length) $("#import-text").value = "";
    toast(`${r.studentsCreated} сурагч, ${r.guardiansAdded} асран хамгаалагч нэмэгдлээ`, r.errors.length ? "warn" : "info");
    await refresh();
  });
});

// ---- Roster ------------------------------------------------------------
const renderRoster = () => {
  const { students } = state.roster;
  // Siblings share a guardian: show who else the person is linked to.
  const childrenOf = new Map();
  for (const s of students) for (const g of s.guardians) childrenOf.set(g._id, [...(childrenOf.get(g._id) ?? []), s.firstName]);

  $("#roster").innerHTML = students.length
    ? students
        .map((s) => {
          const rows = s.guardians
            .map((g, i) => {
              const siblings = (childrenOf.get(g._id) ?? []).filter((name) => name !== s.firstName);
              return html`<tr data-guardian="${g._id}" data-student="${s._id}">
                <td class="sub">${i + 1}</td>
                <td><input name="relation" value="${g.relation}" aria-label="Хэн" /></td>
                <td><input name="name" value="${g.name}" aria-label="Нэр" />
                  ${raw(siblings.length ? html`<div class="sub">Мөн: ${siblings.join(", ")}</div>` : "")}</td>
                <td><input name="phone" value="${g.phone}" inputmode="tel" aria-label="Утас" /></td>
                <td><input type="checkbox" name="canPickup" ${raw(g.canPickup === false ? "" : "checked")} aria-label="Хүүхэд авч болно" style="width: auto" /></td>
                <td><div class="actions">
                  <button class="btn small" data-guardian-move="up" title="Түрүүлж залгах" ${raw(i === 0 ? "disabled" : "")}>↑</button>
                  <button class="btn small" data-guardian-move="down" title="Дараа нь залгах" ${raw(i === s.guardians.length - 1 ? "disabled" : "")}>↓</button>
                  <button class="btn small primary" data-guardian-save>Хадгалах</button>
                  <button class="btn small danger" data-guardian-remove title="Хасах">✕</button>
                </div></td>
              </tr>`;
            })
            .join("");
          return html`<div class="item" data-student-card="${s._id}">
            <div class="item-head">
              <input name="firstName" value="${s.firstName}" aria-label="Нэр" style="max-width: 160px; font-weight: 600" />
              <input name="lastName" value="${s.lastName}" aria-label="Овог" style="max-width: 90px" />
              <button class="btn small" data-student-save="${s._id}">Хадгалах</button>
              <button class="btn small danger" data-student-delete="${s._id}">Сурагч устгах</button>
              ${raw(s.guardians.length ? "" : `<span class="badge" data-tone="danger">Залгах хүн алга</span>`)}
            </div>
            <div class="table-wrap"><table>
              <thead><tr><th>#</th><th>Хэн</th><th>Нэр</th><th>Утас</th><th title="Хүүхэд авч болно">Авах</th><th></th></tr></thead>
              <tbody>${raw(rows)}
                <tr data-new-guardian="${s._id}">
                  <td class="sub">+</td>
                  <td><input name="relation" placeholder="эмээ" aria-label="Хэн" /></td>
                  <td><input name="name" placeholder="Нэр" aria-label="Нэр" /></td>
                  <td><input name="phone" placeholder="99112233" inputmode="tel" aria-label="Утас" /></td>
                  <td></td>
                  <td><button class="btn small" data-guardian-add="${s._id}">+ Нэмэх</button></td>
                </tr>
              </tbody>
            </table></div>
          </div>`;
        })
        .join("")
    : `<div class="empty">Сурагч алга. Дээрх маягтаар нэмэх эсвэл Excel-ээс хуулж оруулна уу.</div>`;
};

$("#roster").addEventListener("input", () => {
  state.rosterDirty = true;
});

// Enter in a guardian row saves (or adds) that row.
$("#roster").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.target.tagName !== "INPUT") return;
  const row = event.target.closest("tr");
  row?.querySelector("[data-guardian-save], [data-guardian-add]")?.click();
});

// ---- Actions (delegated) -----------------------------------------------
const withBusy = async (button, fn) => {
  if (button) button.disabled = true;
  try {
    await fn();
  } catch (error) {
    toast(error.message, "danger");
  } finally {
    if (button) button.disabled = false;
  }
};

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  const d = target.dataset;

  if (d.attendance) {
    return withBusy(target, async () => {
      await api("/attendance", { method: "POST", body: { studentId: d.student, status: d.attendance } });
      await refresh();
    });
  }
  if (d.picked) {
    return withBusy(target, async () => {
      await api(`/students/${d.picked}/picked-up`, { method: "POST", body: {} });
      await refresh();
    });
  }
  if (d.pickupReset) {
    return withBusy(target, async () => {
      await api(`/students/${d.pickupReset}/pickup-reset`, { method: "POST", body: {} });
      await refresh();
    });
  }
  if (d.call) {
    return withBusy(target, async () => {
      await api("/calls", { method: "POST", body: { purpose: d.call, studentId: d.student } });
      toast("Залгаж байна… Эцэг эхийн утсан дээр дуудлага очлоо.");
      await refresh();
    });
  }
  if (d.meetingRemind) {
    return withBusy(target, async () => {
      const r = await api(`/meetings/${d.meetingRemind}/remind-now`, { method: "POST", body: {} });
      toast(`${r.sent} эцэг эхэд SMS сануулга илгээлээ`);
      await refresh();
    });
  }
  if (d.meetingCall) {
    return withBusy(target, async () => {
      const r = await api(`/meetings/${d.meetingCall}/call`, { method: "POST", body: {} });
      toast(`${r.started} эцэг эх рүү залгаж байна`);
    });
  }

  // Roster rows: guardian id and student id live on the <tr>.
  const row = target.closest("tr[data-guardian]");
  if (row && d.guardianSave !== undefined) {
    return withBusy(target, async () => {
      await api(`/guardians/${row.dataset.guardian}`, {
        method: "PATCH",
        body: { ...readGuardian(row), canPickup: row.querySelector('[name="canPickup"]').checked },
      });
      toast("Хадгаллаа");
      await refresh();
    });
  }
  if (row && d.guardianRemove !== undefined) {
    const name = row.querySelector('[name="name"]').value;
    if (!confirm(`${name}-г энэ сурагчаас хасах уу?`)) return;
    return withBusy(target, async () => {
      await api(`/students/${row.dataset.student}/guardians/${row.dataset.guardian}`, { method: "DELETE" });
      await refresh();
    });
  }
  if (row && d.guardianMove) {
    return withBusy(target, async () => {
      await api(`/students/${row.dataset.student}/guardians/${row.dataset.guardian}/move`, {
        method: "POST",
        body: { direction: d.guardianMove },
      });
      await refresh();
    });
  }
  if (d.guardianAdd) {
    const newRow = target.closest("tr");
    return withBusy(target, async () => {
      await api(`/students/${d.guardianAdd}/guardians`, { method: "POST", body: readGuardian(newRow) });
      toast("Асран хамгаалагч нэмэгдлээ");
      await refresh();
    });
  }
  if (d.studentSave) {
    const card = target.closest("[data-student-card]");
    return withBusy(target, async () => {
      await api(`/students/${d.studentSave}`, {
        method: "PATCH",
        body: { firstName: card.querySelector('[name="firstName"]').value, lastName: card.querySelector('[name="lastName"]').value },
      });
      toast("Хадгаллаа");
      await refresh();
    });
  }
  if (d.studentDelete) {
    const card = target.closest("[data-student-card]");
    if (!confirm(`${card.querySelector('[name="firstName"]').value}-г устгах уу? Ирц, дуудлагын түүх нь хамт устна.`)) return;
    return withBusy(target, async () => {
      await api(`/students/${d.studentDelete}`, { method: "DELETE" });
      await refresh();
    });
  }

  switch (d.action) {
    case "all-present":
      return withBusy(target, async () => {
        const ids = state.today.rows.filter((r) => r.record.attendance === "unknown").map((r) => r.student._id);
        await api("/attendance/bulk", { method: "POST", body: { studentIds: ids, status: "present" } });
        toast(`${ids.length} сурагчийг ирсэн гэж бүртгэлээ`);
        await refresh();
      });
    case "notify-absent":
      return withBusy(target, async () => {
        const r = await api("/absence/notify", { method: "POST", body: {} });
        toast(r.started ? `${r.started} хүүхдийн эцэг эх рүү залгаж байна` : "Мэдэгдэх шинэ тасалсан хүүхэд алга");
        await refresh();
      });
    case "check-pickup":
      return withBusy(target, async () => {
        const r = await api("/pickup/check-now", { method: "POST", body: {} });
        toast(r.started ? `${r.started} хүүхдийн эцэг эх рүү залгаж эхэллээ` : "Хүлээгдэж буй хүүхэд алга");
        await refresh();
      });
    case "summary":
      return withBusy(target, async () => {
        const r = await api("/summary");
        $("#summary-card").classList.remove("hidden");
        $("#summary-text").textContent = r.text;
        $("#summary-engine").textContent = r.engine === "llm" ? modelLabel(r.model) : "Загвар";
        $("#summary-engine").className = `badge ${r.engine === "llm" ? "ai" : ""}`;
      });
    case "draft-sms":
      return withBusy(target, async () => {
        const note = $("#sms-text").value.trim();
        if (!note) return toast("Эхлээд товч тэмдэглэл бичнэ үү", "warn");
        const r = await api("/sms/draft", { method: "POST", body: { note } });
        $("#sms-text").value = r.text;
        updateSmsCounter();
        toast(r.engine === "llm" ? `${modelLabel(r.model)} найрууллаа` : "AI холбогдоогүй тул загвараар бэлдлээ", r.engine === "llm" ? "info" : "warn");
      });
    case "send-sms":
      return withBusy(target, async () => {
        const text = $("#sms-text").value.trim();
        if (!text) return toast("Мессеж хоосон байна", "warn");
        if (!selected.size) return toast("Хүлээн авагч сонгоно уу", "warn");
        const r = await api("/sms/bulk", { method: "POST", body: { guardianIds: [...selected], text } });
        toast(`${r.sent} SMS илгээлээ${r.failed ? `, ${r.failed} алдаа` : ""}`, r.failed ? "warn" : "info");
        $("#sms-text").value = "";
        selected.clear();
        await refresh();
      });
    case "add-guardian-row":
      $("#s-guardians").append(guardianRow("эмээ"));
      return;
    case "erxes-sync":
      return withBusy(target, async () => {
        const r = await api("/erxes/sync", { method: "POST", body: {} });
        $("#erxes-result").textContent = `${r.synced}/${r.total} синк хийлээ${r.results.find((x) => !x.synced) ? `\n${r.results.find((x) => !x.synced).reason}` : ""}`;
      });
    case "roster-clear":
      if (!confirm("Demo сурагч, эцэг эх, дуудлага, SMS бүгд устна. Ангийн тохиргоо үлдэнэ. Үргэлжлүүлэх үү?")) return;
      return withBusy(target, async () => {
        await api("/roster/clear", { method: "POST", body: {} });
        toast("Цэвэрлэлээ. Одоо өөрсдийн сурагч, эцэг эхээ нэмнэ үү.");
        $("#s-first").focus();
        await refresh();
      });
    case "demo-reset":
      if (!confirm("Бүх өгөгдлийг устгаж demo ангийг дахин үүсгэх үү?")) return;
      return withBusy(target, async () => {
        await api("/demo/reset", { method: "POST", body: {} });
        toast("Demo өгөгдлийг шинэчиллээ");
        await refresh();
      });
  }
});

// ---- Live updates ------------------------------------------------------
listen("/events", {
  today: scheduleRefresh,
  call: scheduleRefresh,
  sms: scheduleRefresh,
  meeting: scheduleRefresh,
  alert: (data) => {
    toast(data.message, data.level === "danger" ? "danger" : "warn");
    scheduleRefresh();
  },
});

setInterval(loadStatus, 30_000);
loadStatus().catch((error) => toast(error.message, "danger"));

let initialTab = "today";
try {
  initialTab = localStorage.getItem("subedei.tab") || "today";
} catch {}
showTab(document.querySelector(`[data-tab="${initialTab}"]`) ? initialTab : "today");
