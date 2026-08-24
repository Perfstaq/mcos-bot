import { useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Sidebar } from "./components/Sidebar.js";
import { RequireAuth } from "./components/RequireAuth.js";
import { Meetings } from "./pages/Meetings.js";
import { ReviewQueue } from "./pages/ReviewQueue.js";
import { Brief } from "./pages/Brief.js";
import { MeetingWorkspace } from "./pages/MeetingWorkspace.js";
import { CalendarSettings } from "./pages/CalendarSettings.js";
import { CalendarView } from "./pages/CalendarView.js";
import { Library } from "./pages/Library.js";
import { NotesList } from "./pages/NotesList.js";
import { ActionItems } from "./pages/ActionItems.js";
import { UserSettings } from "./pages/UserSettings.js";
import { Search } from "./pages/Search.js";
import { WorkspaceSettings } from "./pages/WorkspaceSettings.js";
import { SignIn } from "./pages/SignIn.js";
import { SignUp } from "./pages/SignUp.js";
import { Onboarding } from "./pages/Onboarding.js";
import { useSession } from "./auth-client.js";
import { api } from "./api.js";

/**
 * Two shells, not one.
 *
 * Sign-in, sign-up and onboarding render bare, outside the workspace grid — a
 * signed-out visitor must never see the navigation rail of a workspace they are
 * not in. Everything else renders inside the shell behind RequireAuth.
 */
export function App() {
  return (
    <Routes>
      <Route path="/signin" element={<SignIn />} />
      <Route path="/signup" element={<SignUp />} />
      <Route path="/onboarding" element={<Onboarding />} />
      <Route
        path="*"
        element={
          <RequireAuth>
            <Workspace />
          </RequireAuth>
        }
      />
    </Routes>
  );
}

function Workspace() {
  const session = useSession();
  const [pending, setPending] = useState<number | null>(null);

  const refreshCount = useCallback(async () => {
    try {
      const data = await api.get<{ claims: unknown[] }>("/review-queue?status=proposed");
      setPending(data.claims.length);
    } catch {
      setPending(null);
    }
  }, []);

  useEffect(() => {
    void refreshCount();
  }, [refreshCount]);

  return (
    <div className="app">
      <Sidebar
        pending={pending}
        reviewer={session.data?.user.email ?? ""}
        userName={session.data?.user.name ?? ""}
      />
      <Routes>
        <Route path="/" element={<Navigate to="/meetings" replace />} />
        <Route path="/meetings" element={<Meetings />} />
        {/* Both paths reach the same screen: MyActionItems links to
            /workspace, while playback deep links target the bare id. */}
        <Route path="/meetings/:id" element={<MeetingWorkspace />} />
        <Route path="/meetings/:id/workspace" element={<MeetingWorkspace />} />
        <Route path="/review" element={<ReviewQueue onCountChange={setPending} />} />
        <Route path="/brief" element={<Brief />} />
        {/* MyActionItems was folded into ActionItems, which is a superset.
            The old path still resolves so existing links do not rot. */}
        <Route path="/action-items" element={<ActionItems />} />
        <Route path="/my-actions" element={<Navigate to="/action-items" replace />} />
        <Route path="/library" element={<Library />} />
        <Route path="/notes" element={<NotesList />} />
        <Route path="/me" element={<UserSettings />} />
        <Route path="/search" element={<Search />} />
        {/* The grid is the screen people use; settings is where you go once. */}
        <Route path="/calendar" element={<CalendarView />} />
        <Route path="/calendar/settings" element={<CalendarSettings />} />
        <Route path="/settings" element={<WorkspaceSettings />} />
        <Route path="*" element={<Navigate to="/meetings" replace />} />
      </Routes>
    </div>
  );
}
