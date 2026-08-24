import { NavLink } from "react-router-dom";
import { PerfstaqLogo } from "./PerfstaqLogo.js";
import {
  IconBrief,
  IconCheck,
  IconMeetings,
  IconReview,
  IconSearch,
  IconSettings,
} from "./Icons.js";

/**
 * The persistent rail. It never scrolls with content and never changes between
 * screens, so the stages of the ring — evidence in, decision, memory — stay
 * visible as one pipeline rather than a set of unrelated pages.
 */
export function Sidebar({
  pending,
  reviewer,
  userName,
}: {
  pending: number | null;
  reviewer: string;
  userName: string;
}) {
  return (
    <aside className="rail">
      <div className="rail-brand">
        <NavLink to="/meetings" aria-label="Perfstaq">
          <PerfstaqLogo height={20} animate />
        </NavLink>
      </div>

      <div className="rail-section">
        <div className="rail-label">Pipeline</div>

        <NavLink to="/meetings" className={({ isActive }) => `rail-link${isActive ? " active" : ""}`}>
          <IconMeetings />
          <span className="grow">Meetings</span>
        </NavLink>

        <NavLink to="/review" className={({ isActive }) => `rail-link${isActive ? " active" : ""}`}>
          <IconReview />
          <span className="grow">Review queue</span>
          {pending ? <span className="badge">{pending}</span> : null}
        </NavLink>

        <NavLink to="/brief" className={({ isActive }) => `rail-link${isActive ? " active" : ""}`}>
          <IconBrief />
          <span className="grow">Brief</span>
        </NavLink>
      </div>

      <div className="rail-section" style={{ marginTop: 18 }}>
        <div className="rail-label">Workspace</div>

        <NavLink to="/my-actions" className={({ isActive }) => `rail-link${isActive ? " active" : ""}`}>
          <IconCheck size={18} />
          <span className="grow">My actions</span>
        </NavLink>

        <NavLink to="/search" className={({ isActive }) => `rail-link${isActive ? " active" : ""}`}>
          <IconSearch />
          <span className="grow">Search</span>
        </NavLink>

        <NavLink to="/calendar" className={({ isActive }) => `rail-link${isActive ? " active" : ""}`}>
          <IconMeetings />
          <span className="grow">Calendars</span>
        </NavLink>

        <NavLink to="/settings" className={({ isActive }) => `rail-link${isActive ? " active" : ""}`}>
          <IconSettings />
          <span className="grow">Settings</span>
        </NavLink>
      </div>

      <div className="rail-foot">
        <div className="who">{userName || reviewer}</div>
        <div className="where mono">{reviewer}</div>
      </div>
    </aside>
  );
}
