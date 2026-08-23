import { NavLink } from "react-router-dom";
import { PerfstaqLogo } from "./PerfstaqLogo.js";
import { IconBrief, IconMeetings, IconReview } from "./Icons.js";

/**
 * The persistent rail. It never scrolls with content and never changes between
 * screens, so the three stages of the ring — evidence in, decision, memory —
 * stay visible as a single pipeline rather than three unrelated pages.
 */
export function Sidebar({ pending, tenant, reviewer }: { pending: number | null; tenant: string; reviewer: string }) {
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

      <div className="rail-foot">
        <div className="who">{reviewer}</div>
        <div className="where mono">{tenant}</div>
      </div>
    </aside>
  );
}
