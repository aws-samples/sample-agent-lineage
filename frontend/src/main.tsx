import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { LazyMotion, MotionConfig } from "motion/react";
import App from "./App";
import { Docs } from "./components/Docs";
import { Landing } from "./components/Landing";
import { initAuth, type AuthState } from "./auth";
import "./styles.css";

const loadMotionFeatures = () => import("./motion-features").then((m) => m.default);

/** Hash route: "#/docs" (optionally "#/docs#section") opens documentation
 *  from the landing page or the app; everything else is the main flow. */
function useHashRoute(): string {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

/** Pre-auth landing → hosted-UI sign-in → app. Locally (auth disabled) the
 *  landing is still shown once so the product story is previewable; "Enter"
 *  goes straight in. */
function Root({ initial }: { initial: AuthState }) {
  const [entered, setEntered] = useState(false);
  const hash = useHashRoute();

  if (hash.startsWith("#/docs")) {
    return <Docs onBack={() => { window.location.hash = ""; }} />;
  }
  if (initial.kind === "unreachable") return <App />;
  if (initial.kind === "ready" && (initial.enabled || entered)) return <App />;
  if (initial.kind === "ready") {
    return <Landing mode="local" onEnter={() => setEntered(true)} />;
  }
  return <Landing mode="signin" onEnter={initial.signIn} />;
}

initAuth().then((state) => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      {/* Motion: honour the OS "reduce motion" setting (transform and layout
          animations are skipped, opacity fades remain) and share the app's
          ease-out curve. Features load lazily after first paint; `strict`
          flags any full `motion.*` import that would bypass LazyMotion. */}
      <MotionConfig reducedMotion="user" transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}>
        <LazyMotion features={loadMotionFeatures} strict>
          <Root initial={state} />
        </LazyMotion>
      </MotionConfig>
    </React.StrictMode>,
  );
});
