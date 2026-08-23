import { useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Sidebar } from "./components/Sidebar.js";
import { Meetings } from "./pages/Meetings.js";
import { ReviewQueue } from "./pages/ReviewQueue.js";
import { Brief } from "./pages/Brief.js";
import { api } from "./api.js";

const TENANT = "freshworks-demo";
const REVIEWER = "demo@freshworks.example";

export function App() {
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
      <Sidebar pending={pending} tenant={TENANT} reviewer={REVIEWER} />
      <Routes>
        <Route path="/" element={<Navigate to="/meetings" replace />} />
        <Route path="/meetings" element={<Meetings />} />
        <Route path="/review" element={<ReviewQueue onCountChange={setPending} />} />
        <Route path="/brief" element={<Brief />} />
        <Route path="*" element={<Navigate to="/meetings" replace />} />
      </Routes>
    </div>
  );
}
