import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";

// タッチ操作で長押しメニューが出ないようにする
window.addEventListener("contextmenu", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
