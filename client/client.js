/**
 * dsh-balance —— 常驻余额指示器（Client 半边，手写 CJS bundle，无需打包器）。
 *
 * 由 DSH 客户端模块系统加载：id 必须严格等于包名 `dsh-balance`，
 * 物化时返回 CommonJS exports（apply + inject）。
 * 数据来自 Host 半边注册的同源只读路由 /api/dsh-balance/summary。
 *
 * 视觉：全部使用产品自身的主题变量（--dsw-alias-* / --dsw-elevation-* / --dsw-font-family），
 * 因此明暗主题、字号设置都会自动跟随，观感与原生控件一致。
 *
 * 交互：
 * - 拖动：按住任意位置拖到屏幕任意处（指针捕获，触摸可用），位置存 localStorage，刷新后保留；
 * - 单击：展开/收起明细（位移 < 4px 才算点击，不会和拖动混淆）；
 * - 双击：复位到右下角默认位置并清除记忆；
 * - 窗口缩放：自动把胶囊拉回可视范围内。
 */
window.__ModuleLoader__.load({
  id: "dsh-balance",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    var ROUTE = "/api/dsh-balance/summary";
    var REFRESH_MS = 60000;
    var POSITION_KEY = "dsh-balance:position";
    var DEFAULT_INSET = 14;
    var DRAG_THRESHOLD = 4;

    /** 产品主题变量（都带兜底值，主题缺 token 时也不会塌） */
    var T = {
      surface: "var(--dsw-alias-bg-overlay, rgba(127,127,127,0.14))",
      surfaceHover: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.2))",
      border: "var(--dsw-alias-border-l2, rgba(127,127,127,0.28))",
      label: "var(--dsw-alias-label-primary, inherit)",
      labelSecondary: "var(--dsw-alias-label-secondary, inherit)",
      labelTertiary: "var(--dsw-alias-label-tertiary, inherit)",
      warn: "var(--dsw-alias-state-warn-label, #dd8629)",
      shadow: "var(--dsw-elevation-soft, 0 2px 8px rgba(0,0,0,0.08))",
      font: "var(--dsw-font-family, -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif)",
      fontCode: "var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
    };

    function readStoredPosition() {
      try {
        var raw = globalThis.localStorage.getItem(POSITION_KEY);
        if (raw === null || raw === "") return null;
        var parsed = JSON.parse(raw);
        if (typeof parsed.left === "number" && typeof parsed.top === "number") return parsed;
      } catch (error) {
        /* 隐私模式或损坏数据都退回默认位置 */
      }
      return null;
    }

    function storePosition(position) {
      try {
        globalThis.localStorage.setItem(POSITION_KEY, JSON.stringify(position));
      } catch (error) {
        /* 存不了就算了，本次会话内仍然可拖动 */
      }
    }

    function clearStoredPosition() {
      try {
        globalThis.localStorage.removeItem(POSITION_KEY);
      } catch (error) {
        /* 同上 */
      }
    }

    function statusText(item) {
      if (item.status === "ok") return item.text || "已获取";
      if (item.status === "no-key") return "未配置密钥";
      if (item.status === "key-rejected") return "密钥被拒";
      if (item.status === "no-endpoint") return "无余额接口";
      if (item.status === "needs-panel-token") return "需面板令牌";
      return "查询失败";
    }

    /** 摘要：{ text, warn } —— warn 为真时另起一个用告警色渲染的标记。 */
    function summarize(snapshot) {
      if (snapshot.phase === "loading") return { text: "余额 …", warn: false };
      if (snapshot.phase === "error") return { text: "余额不可用", warn: true };
      var items = (snapshot.body && snapshot.body.items) || [];
      var ok = items.filter(function (item) {
        return item.status === "ok";
      });
      if (ok.length === 0) return { text: "余额不可用", warn: true };
      var text = ok
        .map(function (item) {
          return item.text || item.label;
        })
        .join(" · ");
      var troubled = items.some(function (item) {
        return item.status !== "ok";
      });
      return { text: text, warn: troubled };
    }

    function details(snapshot) {
      if (snapshot.phase === "error") return snapshot.message;
      var items = (snapshot.body && snapshot.body.items) || [];
      return items
        .map(function (item) {
          return item.label + "：" + statusText(item) + (item.detail ? "（" + item.detail + "）" : "");
        })
        .join("\n");
    }

    /** 把左上角坐标夹进可视区，允许贴边。 */
    function clampToViewport(element, left, top) {
      var width = element === null ? 120 : element.offsetWidth;
      var height = element === null ? 26 : element.offsetHeight;
      var viewportWidth = globalThis.innerWidth || 1280;
      var viewportHeight = globalThis.innerHeight || 720;
      var maxLeft = Math.max(0, viewportWidth - width - 2);
      var maxTop = Math.max(0, viewportHeight - height - 2);
      return {
        left: Math.min(Math.max(0, Math.round(left)), maxLeft),
        top: Math.min(Math.max(0, Math.round(top)), maxTop),
      };
    }

    function BalanceIndicator() {
      var stateHook = React.useState({ phase: "loading" });
      var snapshot = stateHook[0];
      var setSnapshot = stateHook[1];
      var openHook = React.useState(false);
      var open = openHook[0];
      var setOpen = openHook[1];
      var positionHook = React.useState(readStoredPosition);
      var position = positionHook[0];
      var setPosition = positionHook[1];
      var draggingHook = React.useState(false);
      var dragging = draggingHook[0];
      var setDragging = draggingHook[1];
      var hoverHook = React.useState(false);
      var hovered = hoverHook[0];
      var setHovered = hoverHook[1];

      var rootRef = React.useRef(null);
      var dragRef = React.useRef(null);

      React.useEffect(function () {
        var alive = true;
        function load() {
          fetch(ROUTE, { headers: { accept: "application/json" } })
            .then(function (response) {
              if (!response.ok) throw new Error("HTTP " + response.status);
              return response.json();
            })
            .then(function (body) {
              if (alive) setSnapshot({ phase: "ready", body: body });
            })
            .catch(function (error) {
              if (alive) setSnapshot({ phase: "error", message: String((error && error.message) || error) });
            });
        }
        load();
        var timer = setInterval(load, REFRESH_MS);
        return function () {
          alive = false;
          clearInterval(timer);
        };
      }, []);

      React.useEffect(
        function () {
          function onResize() {
            setPosition(function (current) {
              if (current === null) return current;
              return clampToViewport(rootRef.current, current.left, current.top);
            });
          }
          globalThis.addEventListener("resize", onResize);
          return function () {
            globalThis.removeEventListener("resize", onResize);
          };
        },
        [],
      );

      function pointerDown(event) {
        if (event.button !== undefined && event.button !== 0) return;
        var element = rootRef.current;
        if (element === null) return;
        var rect = element.getBoundingClientRect();
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          startLeft: rect.left,
          startTop: rect.top,
          moved: false,
          last: { left: rect.left, top: rect.top },
        };
        try {
          element.setPointerCapture(event.pointerId);
        } catch (error) {
          /* 不支持捕获时仍可拖动，只是指针移出元素会断 */
        }
        event.preventDefault();
      }

      function pointerMove(event) {
        var drag = dragRef.current;
        if (drag === null || drag.pointerId !== event.pointerId) return;
        var dx = event.clientX - drag.startX;
        var dy = event.clientY - drag.startY;
        if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        if (!drag.moved) {
          drag.moved = true;
          setDragging(true);
        }
        var next = clampToViewport(rootRef.current, drag.startLeft + dx, drag.startTop + dy);
        drag.last = next;
        setPosition(next);
      }

      function pointerUp(event) {
        var drag = dragRef.current;
        if (drag === null || drag.pointerId !== event.pointerId) return;
        dragRef.current = null;
        setDragging(false);
        var element = rootRef.current;
        if (element !== null) {
          try {
            element.releasePointerCapture(event.pointerId);
          } catch (error) {
            /* 没捕获成功时忽略 */
          }
        }
        if (drag.moved) storePosition(drag.last);
        else setOpen(!open);
      }

      function resetPosition() {
        clearStoredPosition();
        setPosition(null);
        setOpen(false);
      }

      var summary = summarize(snapshot);
      var items = (snapshot.body && snapshot.body.items) || [];
      var children = [
        React.createElement(
          "span",
          {
            key: "head",
            style: { color: T.label, fontWeight: 500, letterSpacing: "0.01em" },
          },
          summary.text,
          summary.warn
            ? React.createElement("span", { key: "warn", style: { color: T.warn, marginLeft: "4px" }, title: "有 provider 取不到余额" }, "⚠")
            : null,
        ),
      ];
      if (open) {
        children.push(
          React.createElement(
            "div",
            {
              key: "list",
              style: {
                marginTop: "5px",
                paddingTop: "5px",
                borderTop: "1px solid " + T.border,
                display: "flex",
                flexDirection: "column",
                gap: "3px",
                color: T.labelSecondary,
              },
            },
            items.length === 0
              ? React.createElement("div", null, details(snapshot))
              : items.map(function (item) {
                  return React.createElement(
                    "div",
                    { key: item.id, style: { display: "flex", gap: "6px", alignItems: "baseline", whiteSpace: "nowrap" } },
                    React.createElement("span", { style: { color: T.label, fontWeight: 500, minWidth: "58px" } }, item.label),
                    React.createElement(
                      "span",
                      { style: { color: item.status === "ok" ? T.labelSecondary : T.warn } },
                      statusText(item),
                    ),
                    item.detail
                      ? React.createElement("span", { style: { color: T.labelTertiary } }, item.detail)
                      : null,
                  );
                }),
          ),
        );
      }

      var anchorStyle =
        position === null
          ? { right: DEFAULT_INSET + "px", bottom: DEFAULT_INSET - 2 + "px" }
          : { left: position.left + "px", top: position.top + "px" };

      var style = {
        position: "fixed",
        zIndex: 60,
        maxWidth: "360px",
        padding: "3px 9px",
        borderRadius: "999px",
        border: "1px solid " + T.border,
        background: hovered || open ? T.surfaceHover : T.surface,
        boxShadow: T.shadow,
        color: T.label,
        fontFamily: T.font,
        fontSize: "11.5px",
        fontVariantNumeric: "tabular-nums",
        lineHeight: "16px",
        cursor: dragging ? "grabbing" : "grab",
        userSelect: "none",
        WebkitUserSelect: "none",
        touchAction: "none",
        pointerEvents: "auto",
        textAlign: "left",
        transition: "background-color var(--ds-transition-duration-fast, .1s)",
      };
      Object.keys(anchorStyle).forEach(function (key) {
        style[key] = anchorStyle[key];
      });

      return React.createElement(
        "div",
        {
          ref: rootRef,
          onPointerDown: pointerDown,
          onPointerMove: pointerMove,
          onPointerUp: pointerUp,
          onPointerCancel: pointerUp,
          onPointerEnter: function () {
            setHovered(true);
          },
          onPointerLeave: function () {
            setHovered(false);
          },
          onDoubleClick: resetPosition,
          title: details(snapshot) + "\n（拖动可移到任意位置 · 单击展开/收起 · 双击复位 · 60 秒自动刷新）",
          style: style,
        },
        children,
      );
    }

    var inject = ["slots"];

    function apply(ctx) {
      var slots = ctx.get("slots");
      if (slots === undefined) return;
      slots.inject("shell.overlay", function () {
        return slots.register({ name: "shell.overlay", id: "dsh-balance", order: 20 }, BalanceIndicator);
      });
    }

    exports.name = "dsh-balance";
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
