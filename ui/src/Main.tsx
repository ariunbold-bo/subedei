import "./styles.css";
import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { AppLayout } from "erxes-ui";
import manifest from "../../erxes.json" with { type: "json" };
import { Navigation } from "./modules/Navigation";
import { isAuthed } from "./modules/auth";

const IndexPage = lazy(() =>
  import("./pages/IndexPage").then((m) => ({ default: m.IndexPage })),
);
const CallsPage = lazy(() =>
  import("./pages/CallsPage").then((m) => ({ default: m.CallsPage })),
);
const SettingsPage = lazy(() =>
  import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);
const LoginPage = lazy(() =>
  import("./pages/LoginPage").then((m) => ({ default: m.LoginPage })),
);

/** Redirects to /login when the user is not authenticated. */
const AuthGuard = ({ children }: { children: ReactNode }) => {
  const location = useLocation();
  if (!isAuthed()) {
    return <Navigate to="login" state={{ from: location }} replace />;
  }
  return <>{children}</>;
};

const AnimatedRoutes = () => {
  const location = useLocation();
  return (
    <div key={location.pathname} className="subedei:subedei-page-slide subedei:h-full">
      <Routes location={location}>
        <Route index element={<IndexPage />} />
        <Route path="calls" element={<CallsPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Routes>
    </div>
  );
};

// core-ui mounts this component at `/<path>/*`; routes below are relative to
// it. It resolves the component by the PascalCase expose name.
export const Subedei = () => (
  <Routes>
    {/* Login — no AppLayout / sidebar */}
    <Route
      path="login"
      element={
        <Suspense fallback={<div role="status">Ачаалж байна…</div>}>
          <LoginPage />
        </Suspense>
      }
    />

    {/* All other routes — protected */}
    <Route
      path="*"
      element={
        <AuthGuard>
          <AppLayout id={manifest.name} title={manifest.title} sidebar={<Navigation />}>
            <Suspense fallback={<div role="status">Ачаалж байна…</div>}>
              <AnimatedRoutes />
            </Suspense>
          </AppLayout>
        </AuthGuard>
      }
    />
  </Routes>
);
