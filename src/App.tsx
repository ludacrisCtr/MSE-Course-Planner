import { Fragment, useEffect, useMemo, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { WelcomeModal } from "./components/WelcomeModal";
import { useTheme } from "./context/ThemeContext";
import { useWelcomeModal } from "./hooks/useWelcomeModal";
import { courseById, courseEquivalencies, pageTemplates } from "./data";
import {
  fetchSectionsForTerm,
  findHistoricalOffering,
  resolveOfferedSections,
  termTupleToLabel,
} from "./sfuOutlines";
import {
  Course,
  CourseHighlightRole,
  CourseSlot,
  OfferedSection,
  PageTemplate,
  SharedOutlineFields,
  TermPlan,
  VariantId,
} from "./types";
import { courseDependencyGraph } from "./utils/dependencyGraph";
import { getActiveTerms, slotCourseIds } from "./utils/scheduleTerms";
import { computeCompletedCredits, computeTotalCurriculumCredits } from "./utils/credits";

// ─── SFU API Types (outline panel only) ──────────────────────────────────────

interface LiveOutlineBlockProps {
  sharedOutline: SharedOutlineFields;
  sections: OfferedSection[];
  isHistorical?: boolean;
  historicalLabel?: string;
}

type LiveStatus = "idle" | "loading" | "success" | "error" | "not-offered";

interface LiveCourseData {
  status: LiveStatus;
  sharedOutline: SharedOutlineFields | null;
  sections: OfferedSection[];
  isHistorical?: boolean;
  historicalLabel?: string;
  errorMsg?: string;
}

function parseCourseCode(code: string): { dept: string; number: string } | null {
  // Only match simple two-token codes like "MSE 102" or "PHYS 141"
  // Reject placeholders like "COMP ELEC 1", "CO-OP", "MSE 4XX TECH ELEC 1"
  const match = code.trim().match(/^([A-Za-z]{2,8})\s+([A-Za-z0-9]{1,6})$/);
  if (!match) return null;
  return { dept: match[1].toLowerCase(), number: match[2].toLowerCase() };
}

function useLiveCourseData(course: Course | null): LiveCourseData {
  const [state, setState] = useState<LiveCourseData>({ status: "idle", sharedOutline: null, sections: [] });

  useEffect(() => {
    if (!course) {
      setState({ status: "idle", sharedOutline: null, sections: [] });
      return;
    }

    // Parse inside the effect so the closure always has the current course code
    const parsed = parseCourseCode(course.code);
    if (!parsed) {
      setState({ status: "not-offered", sharedOutline: null, sections: [] });
      return;
    }

    let cancelled = false;
    setState({ status: "loading", sharedOutline: null, sections: [] });

    async function fetchData() {
      try {
        const { dept, number } = parsed!;

        // Fetch both terms concurrently; each may return sections or null
        const [currentResult, registrationResult] = await Promise.all([
          fetchSectionsForTerm("current/current", dept, number),
          fetchSectionsForTerm("registration/registration", dept, number),
        ]);

        const currentSections = currentResult?.sections ?? [];
        const registrationSections = registrationResult?.sections ?? [];

        if (currentSections.length === 0 && registrationSections.length === 0) {
          const historical = await findHistoricalOffering(dept, number, 6);
          if (cancelled) return;

          if (historical) {
            setState({
              status: "success",
              sharedOutline: historical.sharedOutline,
              sections: historical.sections,
              isHistorical: true,
              historicalLabel: termTupleToLabel(historical),
            });
          } else {
            setState({ status: "not-offered", sharedOutline: null, sections: [] });
          }
          return;
        }

        const resolved = await resolveOfferedSections(dept, number, [
          currentResult,
          registrationResult,
        ]);

        if (!resolved || resolved.sections.length === 0) {
          if (!cancelled) setState({ status: "not-offered", sharedOutline: null, sections: [] });
          return;
        }

        if (!cancelled) {
          setState({
            status: "success",
            sharedOutline: resolved.sharedOutline,
            sections: resolved.sections,
          });
        }
      } catch (err) {
        if (!cancelled) {
          setState({ status: "error", sharedOutline: null, sections: [], errorMsg: String(err) });
        }
      }
    }

    fetchData();
    return () => { cancelled = true; };
  }, [course?.id]);

  return state;
}

// ─── Progress persistence (checked courses + transfer credits) ──────────────

const COMPLETED_COURSES_STORAGE_KEY = "mse-planner:completed-course-ids";
const TRANSFER_CREDITS_STORAGE_KEY = "mse-planner:transfer-credits";

function loadCompletedCourseIds(): Set<string> {
  try {
    const raw = localStorage.getItem(COMPLETED_COURSES_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    // Ignore any stored ids that no longer correspond to a real course.
    return new Set(
      parsed.filter((id): id is string => typeof id === "string" && !!courseById[id])
    );
  } catch {
    return new Set();
  }
}

function loadTransferCredits(): number {
  try {
    const raw = localStorage.getItem(TRANSFER_CREDITS_STORAGE_KEY);
    if (raw === null) return 0;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

// ─── App ─────────────────────────────────────────────────────────────────────

function App() {
  const { isOpen: isWelcomeOpen, open: openWelcome, dismiss: dismissWelcome } = useWelcomeModal();

  return (
    <>
      <WelcomeModal isOpen={isWelcomeOpen} onDismiss={dismissWelcome} />
      <Routes>
        <Route path="/" element={<Navigate to="/planner/post-2024-4-year" replace />} />
        <Route path="/planner/:pageId" element={<PlannerPage onOpenWelcome={openWelcome} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}

interface PlannerPageProps {
  onOpenWelcome: () => void;
}

function PlannerPage({ onOpenWelcome }: PlannerPageProps) {
  const { pageId } = useParams<{ pageId: string }>();
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const template = pageTemplates.find((p) => p.id === pageId) ?? pageTemplates[0];
  const [variant, setVariant] = useState<VariantId>("A" as VariantId);
  const [selectedCourse, setSelectedCourse] = useState<Course | null>(null);
  const [recursiveHighlights, setRecursiveHighlights] = useState(true);

  // ── Completion / transfer-credit progress ──
  const [completedCourseIds, setCompletedCourseIds] = useState<Set<string>>(loadCompletedCourseIds);
  const [transferCredits, setTransferCredits] = useState<number>(loadTransferCredits);

  useEffect(() => {
    try {
      localStorage.setItem(
        COMPLETED_COURSES_STORAGE_KEY,
        JSON.stringify(Array.from(completedCourseIds))
      );
    } catch {
      // localStorage may be unavailable (private browsing, quota, etc.) - fail silently.
    }
  }, [completedCourseIds]);

  useEffect(() => {
    try {
      localStorage.setItem(TRANSFER_CREDITS_STORAGE_KEY, String(transferCredits));
    } catch {
      // ignore
    }
  }, [transferCredits]);

  const toggleCourseCompleted = (courseId: string) => {
    setCompletedCourseIds((prev) => {
      const next = new Set(prev);
      if (next.has(courseId)) next.delete(courseId);
      else next.add(courseId);
      return next;
    });
  };

  const handleTransferCreditsChange = (event: ChangeEvent<HTMLInputElement>) => {
    const raw = event.target.value;
    if (raw.trim() === "") {
      setTransferCredits(0);
      return;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0 || Number.isNaN(parsed)) {
      setTransferCredits(0);
      return;
    }
    setTransferCredits(parsed);
  };

  const handleTransferCreditsKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Block characters that would let a number input accept decimals/negatives/exponents.
    if (["-", "+", "e", "E", "."].includes(event.key)) {
      event.preventDefault();
    }
  };

  const handleResetProgress = () => {
    const confirmed = window.confirm(
      "Are you sure you want to reset your progress? This will uncheck all completed courses and reset transfer credits."
    );
    if (!confirmed) return;

    setCompletedCourseIds(new Set());
    setTransferCredits(0);
    try {
      localStorage.removeItem(COMPLETED_COURSES_STORAGE_KEY);
      localStorage.removeItem(TRANSFER_CREDITS_STORAGE_KEY);
    } catch {
      // ignore
    }
  };

  const handleCourseSelect = (course: Course) => {
    setSelectedCourse((current) => (current?.id === course.id ? null : course));
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedCourse(null);
      }
    };

    window.addEventListener("keydown", onKeyDown as unknown as EventListener);
    return () => window.removeEventListener("keydown", onKeyDown as unknown as EventListener);
  }, []);

  const relationshipHighlights = useMemo(
    () => courseDependencyGraph.getHighlights(selectedCourse?.id ?? null, recursiveHighlights),
    [selectedCourse?.id, recursiveHighlights]
  );

  const terms = useMemo<TermPlan[]>(() => getActiveTerms(template, variant), [template, variant]);

  const termsByYear = useMemo(() => {
    const grouped = new Map<number, TermPlan[]>();

    for (const term of terms) {
      const match = term.label.match(/Year\s+(\d+)/i);
      const yearNumber = match ? Number(match[1]) : 0;
      const yearTerms = grouped.get(yearNumber) ?? [];
      yearTerms.push(term);
      grouped.set(yearNumber, yearTerms);
    }

    const termOrder = (label: string): number => {
      if (label.includes("Fall")) return 0;
      if (label.includes("Spring")) return 1;
      if (label.includes("Summer")) return 2;
      return 3;
    };

    return [...grouped.entries()]
      .sort(([a], [b]) => a - b)
      .map(([year, yearTerms]) => ({
        year,
        terms: [...yearTerms].sort((a, b) => termOrder(a.label) - termOrder(b.label)),
      }));
  }, [terms]);

  const selectedEquivalencies = useMemo(() => {
    if (!selectedCourse) return [];
    return courseEquivalencies
      .filter((item) => item.sourceCourseId === selectedCourse.id)
      .map((item) => ({ ...item, equivalentCourse: courseById[item.equivalentCourseId] }))
      .filter((item) => Boolean(item.equivalentCourse));
  }, [selectedCourse]);

  const liveData = useLiveCourseData(selectedCourse);

  // ── Credits totals ──
  const totalCurriculumCredits = useMemo(
    () => computeTotalCurriculumCredits(terms, courseById),
    [terms]
  );

  const completedCredits = useMemo(
    () => computeCompletedCredits(terms, completedCourseIds, courseById),
    [terms, completedCourseIds]
  );

  const totalCompleted = completedCredits + transferCredits;
  const completionPercent =
    totalCurriculumCredits > 0 ? Math.round((totalCompleted / totalCurriculumCredits) * 100) : 0;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>SFU MSE Course Navigator</h1>
          <p className="subtitle">ALPHA VERSION</p>
        </div>
        <div className="toolbar">
          <select
            value={template.id}
            onChange={(event) => navigate(`/planner/${event.target.value}`)}
            aria-label="Select page template"
          >
            {pageTemplates.map((page) => (
              <option key={page.id} value={page.id}>
                {page.title}
              </option>
            ))}
          </select>
           {template.supportsVariants && (
              <select
                value={variant}
                onChange={(event) => setVariant(event.target.value as VariantId)}
                aria-label="Select curriculum option"
              >
                {template.availableVariants.map((option) => (
                  <option key={option} value={option}>
                    {template.curriculum === "double-degree"
                      ? option === "B"
                        ? "Pre-Fall 2024"
                        : option === "A"
                            ? "Post-Fall 2024"
                            : `Option ${option}`
                          : `Option ${option}`}
        </option>
              ))}
            </select>
          )}
          {/*<button type="button">Import</button>
          <button type="button">Export</button>
          <button type="button">Settings</button>*/}
          <label className="recursive-toggle">
            <input
              type="checkbox"
              checked={recursiveHighlights}
              onChange={(event) => setRecursiveHighlights(event.target.checked)}
            />
            Recursive highlights
          </label>
          <button
            type="button"
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
          >
            {theme === "light" ? "Dark mode" : "Light mode"}
          </button>
          <button
            type="button"
            className="help-button"
            onClick={onOpenWelcome}
            aria-label="Open welcome and help guide"
            title="Help"
          >
            ?
          </button>
        </div>
      </header>

      <main className="planner-layout">
        <section className="grid-panel">
          <h2>{template.title}</h2>
          <p className="meta">
            Curriculum: <b>{formatCurriculum(template)}</b> | Plan: <b>{template.planLength}</b>
            {template.supportsVariants && template.curriculum !== "double-degree" ? (
              <>
                {" "}
                | 5-year option:  
                  {variant == "A" && <b> 8 Month Co-op (yr2-3) + 4 Month Co-op (yr5)</b>}
                  {variant == "B" && <b> 12 Month Co-op (yr3-4) + 4 Month Co-op (yr5)</b>}
                  {variant == "C" && <b> 8 Month Co-op (yr3-4) + 4 Month Co-op (yr5)</b>}
              </>
            ) : null}
          </p>

          <div className="year-grid">
            {termsByYear.map((yearGroup) => (
              <section key={yearGroup.year} className="year-row">
                <h3 className="year-title">Year {yearGroup.year}</h3>
                <div className="term-grid">
                  {yearGroup.terms.map((term) => (
                    <article key={term.id} className="term-column">
                      <h4>{term.label.split("-")[1]?.trim() ?? term.label}</h4>
                      <div className="course-list">
                        {term.courseIds.map((slot, index) => (
                          <ScheduleSlotCard
                            // Arrays (choice groups) don't have a stable single id, so key on
                            // their joined ids + position; plain slots key on the course id.
                            key={Array.isArray(slot) ? `${slot.join("-")}-${index}` : slot}
                            slot={slot}
                            selectedCourseId={selectedCourse?.id ?? null}
                            highlightRoles={relationshipHighlights.roles}
                            completedCourseIds={completedCourseIds}
                            onToggleCompleted={toggleCourseCompleted}
                            onSelect={handleCourseSelect}
                          />
                        ))}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </section>

        <aside className="details-panel">
          <h2>Course Details</h2>
          {selectedCourse ? (
            <>
              <h3>{selectedCourse.code}</h3>
              <p className="course-title-text">{selectedCourse.title}</p>
              <p>Credits: {selectedCourse.credits}</p>

              <HighlightLegend roles={relationshipHighlights.roles} />

              {/* ── Live SFU Outline ── */}
              <div className="live-section">
                <h4 className="live-section-header">
                  Outline
                  {liveData.status === "loading" && (
                    <span className="live-badge loading">Fetching…</span>
                  )}
                  {liveData.status === "success" && liveData.isHistorical && liveData.historicalLabel && (
                    <span className="live-badge warn">Last offered: {liveData.historicalLabel}</span>
                  )}
                  {liveData.status === "success" && !liveData.isHistorical && (
                    <span className="live-badge success">
                      {liveData.sections.length} section{liveData.sections.length !== 1 ? "s" : ""} found
                    </span>
                  )}
                  {liveData.status === "not-offered" && (
                    <span className="live-badge warn">Not found this term</span>
                  )}
                  {liveData.status === "error" && (
                    <span className="live-badge error">API error</span>
                  )}
                </h4>

                {liveData.status === "loading" && (
                  <p className="empty-note">Contacting SFU Outlines API…</p>
                )}
                {liveData.status === "not-offered" && (
                  <p className="empty-note">
                    No section found for the current or upcoming term. The description above still
                    applies.
                  </p>
                )}
                {liveData.status === "error" && (
                  <p className="empty-note">Could not reach the SFU Outlines API right now.</p>
                )}
                {liveData.status === "success" && liveData.sharedOutline && (
                  <LiveOutlineBlock
                    sharedOutline={liveData.sharedOutline}
                    sections={liveData.sections}
                    isHistorical={liveData.isHistorical}
                    historicalLabel={liveData.historicalLabel}
                  />
                )}
              </div>

              {/* ── Equivalencies ── */}
              <h4>Equivalent Courses (Other Faculties)</h4>
              {selectedEquivalencies.length ? (
                <ul>
                  {selectedEquivalencies.map((eq) => (
                    <li key={`${eq.sourceCourseId}-${eq.equivalentCourseId}`}>
                      {eq.equivalentCourse?.code} ({eq.faculty}, {eq.equivalencyType})
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="empty-note">No equivalencies listed in the seed data yet.</p>
              )}
            </>
          ) : (
            <p className="empty-note">Click a course card to view details and equivalency information.</p>
          )}
        </aside>
      </main>

      <footer className="status-rail">
        <div className="credits-counter">
          <span>Completed Credits: {completedCredits}</span>
          <span className="transfer-credits-field">
            Transfer Credits:{" "}
            <input
              type="number"
              className="transfer-credits-input"
              min={0}
              step={1}
              inputMode="numeric"
              value={transferCredits}
              onChange={handleTransferCreditsChange}
              onKeyDown={handleTransferCreditsKeyDown}
              aria-label="Transfer credits"
            />
          </span>
          <span>
            Progress: {totalCompleted} / {totalCurriculumCredits} Credits ({completionPercent}%)
          </span>
          <button type="button" className="reset-progress-btn" onClick={handleResetProgress}>
            Reset Progress
          </button>
        </div>
        {/*<div>Validation: placeholder</div>
        <div>Warnings: placeholder</div>*/}
      </footer>
    </div>
  );
}

// ─── Course Highlight Helpers ────────────────────────────────────────────────

function getCourseCardClassName(
  courseId: string,
  roles: Map<string, CourseHighlightRole>
): string {
  const role = roles.get(courseId);
  return role ? `course-card role-${role}` : "course-card";
}

interface ScheduleSlotCardProps {
  slot: CourseSlot;
  selectedCourseId: string | null;
  highlightRoles: Map<string, CourseHighlightRole>;
  completedCourseIds: Set<string>;
  onToggleCompleted: (courseId: string) => void;
  onSelect: (course: Course) => void;
}

/**
 * Renders a single slot from a term's `courseIds` config.
 *
 * A slot is either:
 *  - a single course id (string) → renders one course card, exactly as before.
 *  - a "choose one of" group (string[]) → renders every course in the group
 *    side-by-side on one row, separated by an "OR" divider, so the student
 *    can see and pick whichever course they intend to take.
 *
 * This is the only place that knows how to interpret a CourseSlot, so adding
 * a new choice group anywhere in templates.json (or removing one) never
 * requires touching the rest of the component tree.
 */
function ScheduleSlotCard({
  slot,
  selectedCourseId,
  highlightRoles,
  completedCourseIds,
  onToggleCompleted,
  onSelect,
}: ScheduleSlotCardProps) {
  const courseIds = slotCourseIds(slot);
  const isChoiceGroup = courseIds.length > 1;

  return (
    <div
      className={isChoiceGroup ? "course-slot choice-slot" : "course-slot"}
      role={isChoiceGroup ? "group" : undefined}
      aria-label={isChoiceGroup ? "Choose one of the following courses" : undefined}
    >
      {courseIds.map((courseId, index) => {
        const course = courseById[courseId];
        const isCompleted = completedCourseIds.has(courseId);
        return (
          <Fragment key={courseId}>
            {index > 0 && (
              <span className="choice-divider" aria-hidden="true">
                OR
              </span>
            )}
            {course ? (
              <div
                className={`${getCourseCardClassName(course.id, highlightRoles)}${
                  isCompleted ? " completed" : ""
                }`}
                role="button"
                tabIndex={0}
                aria-pressed={selectedCourseId === course.id}
                onClick={() => onSelect(course)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(course);
                  }
                }}
              >
                <label
                  className="course-checkbox"
                  onClick={(event) => event.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={isCompleted}
                    onClick={(event) => event.stopPropagation()}
                    onChange={() => onToggleCompleted(course.id)}
                    aria-label={`Mark ${course.code} as completed`}
                  />
                </label>
                <strong>{course.code}</strong>
                <span>{course.title}</span>
              </div>
            ) : (
              <div className="course-card">
                <strong>Unknown Course</strong>
                <span>{courseId}</span>
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

function HighlightLegend({ roles }: { roles: Map<string, CourseHighlightRole> }) {
  const counts = useMemo(() => {
    const tally = { prerequisite: 0, corequisite: 0, dependent: 0 };
    for (const role of roles.values()) {
      if (role === "prerequisite") tally.prerequisite += 1;
      if (role === "corequisite") tally.corequisite += 1;
      if (role === "dependent") tally.dependent += 1;
    }
    return tally;
  }, [roles]);

  return (
    <div className="highlight-legend" aria-label="Course relationship legend">
      <h4>Curriculum Relationships</h4>
      <div className="legend-item">
        <span className="legend-swatch selected" aria-hidden="true" />
        Selected course
      </div>
      <div className="legend-item">
        <span className="legend-swatch prerequisite" aria-hidden="true" />
        Prerequisites ({counts.prerequisite})
      </div>
      <div className="legend-item">
        <span className="legend-swatch corequisite" aria-hidden="true" />
        Corequisites ({counts.corequisite})
      </div>
      <div className="legend-item">
        <span className="legend-swatch dependent" aria-hidden="true" />
        Dependent courses ({counts.dependent})
      </div>
    </div>
  );
}

// ─── Live Outline Block ───────────────────────────────────────────────────────

function LiveOutlineBlock({ sharedOutline, sections, isHistorical, historicalLabel }: LiveOutlineBlockProps) {
  // Group sections by termLabel so each semester gets its own heading
  const byTerm = sections.reduce<Record<string, OfferedSection[]>>((acc, sec) => {
    (acc[sec.termLabel] ??= []).push(sec);
    return acc;
  }, {});

  return (
    <div className="live-outline">
      {isHistorical && historicalLabel && (
        <p className="empty-note historical-note">
          Not offered in the current or upcoming term. Showing the most recent outline from{" "}
          {historicalLabel}.
        </p>
      )}

      {/* Course description from the API */}
      {sharedOutline.description && (
        <div className="outline-field outline-description">
          <span className="meta-label">Description:</span>
          <p className="outline-description-text">{sharedOutline.description}</p>
        </div>
      )}

      {sharedOutline.prerequisites && (
        <div className="outline-field">
          <span className="meta-label">Prerequisites:</span> {sharedOutline.prerequisites}
        </div>
      )}

      {sharedOutline.corequisites && (
        <div className="outline-field">
          <span className="meta-label">Corequisites:</span> {sharedOutline.corequisites}
        </div>
      )}

      {/* Per-semester offerings */}
      {Object.entries(byTerm).map(([termLabel, termSections]) => (
        <div key={termLabel} className="outline-term-group">
          <p className="outline-term-heading">{termLabel}</p>
          <ul className="inline-list">
            {termSections.map((sec, i) => {
              const instructorNames =
                sec.instructors.length > 0
                  ? sec.instructors.map((inst) => inst.name).join(", ")
                  : "Instructor TBA";
              return (
                <li key={i} className="outline-section-row">
                  <span className="section-tag">{sec.sectionName}</span>
                  <span className="section-campus">{sec.campus}</span>
                  <span className="section-instructor">{instructorNames}</span>
                  {sec.deliveryMethod && (
                    <span className="section-delivery">{sec.deliveryMethod}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {sharedOutline.grades && sharedOutline.grades.length > 0 && (
        <div className="outline-field">
          <span className="meta-label">Grading:</span>
          <ul className="inline-list">
            {sharedOutline.grades.map((g, i) => (
              <li key={i}>
                {g.description}: {g.weight}%
              </li>
            ))}
          </ul>
        </div>
      )}

      {sharedOutline.educationalGoals && (
        <details className="outline-goals">
          <summary>Educational Goals</summary>
          <p>{sharedOutline.educationalGoals}</p>
        </details>
      )}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatCurriculum(template: PageTemplate): string {
  switch (template.curriculum) {
    case "post-2024":
      return "Post-Fall 2024";
    case "pre-2024":
      return "Pre-Fall 2024";
    case "double-degree":
      return "MSE + Business";
    default:
      return template.curriculum;
  }
}

export default App;