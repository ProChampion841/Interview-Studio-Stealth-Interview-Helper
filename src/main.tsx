import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import AreaCapture from "./AreaCapture";
import "./styles.css";
import "./ui.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {window.location.hash === "#area-capture" ? <AreaCapture /> : <App />}
  </React.StrictMode>,
);
