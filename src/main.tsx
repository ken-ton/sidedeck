import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Launcher from "./Launcher";
import Quick from "./Quick";
import "./App.css";

// タッチ操作で長押しメニューやテキスト選択が出ないようにする
window.addEventListener("contextmenu", (e) => e.preventDefault());

const isQuick = getCurrentWindow().label === "quick";
document.body.classList.toggle("quick-window", isQuick);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isQuick ? <Quick /> : <Launcher />}</React.StrictMode>,
);
