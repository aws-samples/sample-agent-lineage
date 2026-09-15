import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { Landing } from "./components/Landing";
import { initAuth, type AuthState } from "./auth";
import "./styles.css";

/** Pre-auth landing → hosted-UI sign-in → app. Locally (auth disabled) the
 *  landing is still shown once so the product story is previewable; "Enter"
 *  goes straight in. */
function Root({ initial }: { initial: AuthState }) {
  const [entered, setEntered] = useState(false);
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
      <Root initial={state} />
    </React.StrictMode>,
  );
});
