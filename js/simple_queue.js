import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const _sessions = {}; 

const MAX_ERROR_LINES = 10; 
const LOG_H           = 80; 
const REQUEUE_DELAY   = 350; 

function callReset(nodeId) {
    api.fetchApi("/simple_queue/reset", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ node_id: nodeId }),
    }).catch((e) => console.error("[SimpleQueue] Reset call failed:", e));
}

function callLogError(nodeId, message) {
    api.fetchApi("/simple_queue/log_error", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ node_id: nodeId, message }),
    }).catch((e) => console.error("[SimpleQueue] Log-error call failed:", e));
}

function _handleRunEnd(node, nodeId) {
    const session = _sessions[nodeId];
    
    // If the session was flagged as aborted by the Cancel button, do not requeue!
    if (!session || !session.ran || session.abort) return;
    
    session.ran = false; 

    const hasMore = node ? node.sqHasMore : session.hasMore;

    if (hasMore) {
        setTimeout(() => {
            // Double check it wasn't aborted during the timeout delay
            if (_sessions[nodeId]?.abort) return;
            
            app.queuePrompt(0, 1).catch((e) => {
                console.error("[SimpleQueue] Re-queue failed:", e);
            });
        }, REQUEUE_DELAY);
    } else {
        if (node) {
            node.sqStatus = "complete";
            node.setDirtyCanvas(true, true);
            callReset(nodeId); 
        }
        delete _sessions[nodeId];
    }
}

app.registerExtension({
    name: "Comfy.SimpleQueue",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "SimpleQueue") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (onNodeCreated) onNodeCreated.apply(this, arguments);

            this.sqIndex    = 0;
            this.sqTotal    = 0;
            this.sqFilename = "";
            this.sqHasMore  = false;
            this.sqSkipped  = 0;
            this.sqErrors   = [];   
            this.sqScrollY  = 0;
            this.sqContentH = 0;
            this.sqStatus   = "idle"; 

            this.sqStatusWidget = {
                type: "sq_status",
                draw: (ctx, node, w, y, h) => {
                    const margin = 10, innerW = w - margin * 2;
                    ctx.save();
                    ctx.fillStyle = "#1a1a1a"; ctx.beginPath(); ctx.roundRect(margin, y + 2, innerW, h - 4, 4); ctx.fill();
                    ctx.font = "normal 11px Arial"; ctx.textAlign = "center";

                    if (this.sqStatus === "idle") {
                        ctx.fillStyle = "#555"; ctx.fillText("Waiting for execution…", w / 2, y + h * 0.65);
                    } else if (this.sqStatus === "running") {
                        const progress = this.sqTotal > 0 ? (this.sqIndex + 1) / this.sqTotal : 0;
                        ctx.fillStyle = "#2a2a2a"; ctx.fillRect(margin, y + h - 9, innerW, 5);
                        ctx.fillStyle = "#4a9eff"; ctx.fillRect(margin, y + h - 9, innerW * progress, 5);
                        ctx.fillStyle = "#eee";
                        const label = `${this.sqIndex + 1} / ${this.sqTotal}  —  ${this._truncate(ctx, this.sqFilename, innerW - 20)}`;
                        ctx.fillText(label, w / 2, y + h * 0.48);
                    } else if (this.sqStatus === "complete") {
                        const done = this.sqTotal - this.sqSkipped;
                        const allGood = this.sqSkipped === 0;
                        ctx.fillStyle = allGood ? "#4ec94e" : "#e0a030";
                        const summary = allGood ? `✅  Done — ${done} / ${this.sqTotal} files` : `⚠️  Done — ${done} / ${this.sqTotal} files  (${this.sqSkipped} skipped)`;
                        ctx.fillText(summary, w / 2, y + h * 0.65);
                    }
                    ctx.restore();
                },
                computeSize: (w) => [w, 42],
            };
            this.widgets.push(this.sqStatusWidget);

            this.sqErrorLogWidget = {
                type: "sq_errorlog",
                draw: (ctx, node, w, y, h) => {
                    const margin = 10, visibleH = LOG_H;
                    ctx.save();
                    ctx.fillStyle = "#111"; ctx.fillRect(margin, y, w - margin * 2, visibleH);
                    if (this.sqErrors.length === 0) {
                        ctx.fillStyle = "#333"; ctx.font = "normal 10px Arial"; ctx.textAlign = "center";
                        ctx.fillText("No errors", w / 2, y + visibleH / 2 + 4);
                    } else {
                        ctx.beginPath(); ctx.rect(margin, y, w - margin * 2, visibleH); ctx.clip();
                        const lineH = 16; ctx.font = "normal 10px Arial"; ctx.textAlign = "left";
                        let curY = y + 13 - this.sqScrollY;
                        for (const line of this.sqErrors) {
                            ctx.fillStyle = "#e06c75"; ctx.fillText(line, margin + 6, curY); curY += lineH;
                        }
                        this.sqContentH = this.sqErrors.length * lineH;
                        if (this.sqContentH > visibleH) {
                            const sbW = 4, sbX = w - margin - sbW;
                            ctx.fillStyle = "#1e1e1e"; ctx.fillRect(sbX, y, sbW, visibleH);
                            const hH = Math.max(10, (visibleH / this.sqContentH) * visibleH);
                            const hY = y + (this.sqScrollY / (this.sqContentH - visibleH)) * (visibleH - hH);
                            ctx.fillStyle = "#555"; ctx.fillRect(sbX, hY, sbW, hH);
                        }
                    }
                    ctx.restore();
                },
                mouse: (event, pos, node) => {
                    if (this.sqErrors.length === 0 || this.sqContentH <= LOG_H) return false;
                    const widgetIndex = node.widgets.indexOf(this.sqErrorLogWidget);
                    let yOffset = node.widgets_start_y || 20;
                    for (let i = 0; i < widgetIndex; i++) yOffset += (node.widgets[i].computeSize ? node.widgets[i].computeSize(node.size[0])[1] : 20) + 4;
                    const localY = pos[1] - yOffset;
                    if (localY < 0 || localY > LOG_H) return false;

                    if (event.buttons === 1) {
                        const raw = (localY / LOG_H) * (this.sqContentH - LOG_H);
                        this.sqScrollY = Math.max(0, Math.min(this.sqContentH - LOG_H, raw));
                        node.setDirtyCanvas(true, true);
                        return true;
                    }
                    return false;
                },
                onMouseWheel: (event) => {
                    if (this.sqContentH <= LOG_H) return false;
                    const raw = this.sqScrollY + (event.deltaY || 0) * 0.5;
                    this.sqScrollY = Math.max(0, Math.min(this.sqContentH - LOG_H, raw));
                    this.setDirtyCanvas(true, true);
                    return true;
                },
                computeSize: (w) => [w, LOG_H + 4],
            };
            this.widgets.push(this.sqErrorLogWidget);

            this.sqResetBtn = this.addWidget("button", "⏹ Reset Queue", null, () => {
                callReset(String(this.id));
                this.sqIndex = 0; this.sqTotal = 0; this.sqFilename = "";
                this.sqHasMore = false; this.sqSkipped = 0; this.sqErrors = [];
                this.sqScrollY = 0; this.sqStatus = "idle";
                
                if (_sessions[String(this.id)]) {
                    delete _sessions[String(this.id)];
                }
                this.setDirtyCanvas(true, true);
            });

            this._truncate = (ctx, text, maxW) => {
                if (ctx.measureText(text).width <= maxW) return text;
                let t = text;
                while (t.length > 0 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
                return t + "…";
            };
        };
    },

    async setup() {
        // --- THE CANCEL FIX ---
        // Intercept ComfyUI's native "Cancel" and "Clear" commands to flag our sessions
        // as aborted before the backend even realizes what happened.
        const origInterrupt = api.interrupt;
        api.interrupt = function () {
            for (const [nodeId, session] of Object.entries(_sessions)) {
                session.abort = true;
                session.ran = false;
                const node = app.graph._nodes.find((n) => n.id.toString() === nodeId);
                if (node) {
                    node.sqStatus = "idle";
                    node.setDirtyCanvas(true, true);
                }
            }
            return origInterrupt.apply(this, arguments);
        };

        const origClearItems = api.clearItems;
        api.clearItems = function () {
            for (const [nodeId, session] of Object.entries(_sessions)) {
                session.abort = true;
                session.ran = false;
                const node = app.graph._nodes.find((n) => n.id.toString() === nodeId);
                if (node) {
                    node.sqStatus = "idle";
                    node.setDirtyCanvas(true, true);
                }
            }
            return origClearItems.apply(this, arguments);
        };
        // ----------------------

        api.addEventListener("simple_queue_update", (e) => {
            const { node_id, index, total, filename, has_more } = e.detail;
            const node = app.graph._nodes.find((n) => n.id.toString() === node_id.toString());
            if (!node) return;

            node.sqIndex = index; node.sqTotal = total; node.sqFilename = filename;
            node.sqHasMore = has_more; node.sqStatus = "running";

            _sessions[node_id.toString()] = { hasMore: has_more, ran: true, abort: false };
            node.setDirtyCanvas(true, true);
        });

        api.addEventListener("execution_error", (e) => {
            for (const [nodeId, session] of Object.entries(_sessions)) {
                if (!session.ran || session.abort) continue;
                
                const node = app.graph._nodes.find((n) => n.id.toString() === nodeId);
                if (node) {
                    node.sqSkipped++;
                    const time = new Date().toLocaleTimeString();
                    const where = `[${node.sqIndex + 1}/${node.sqTotal}] ${node.sqFilename}`;
                    const reason = e.detail?.exception_message || "execution error";
                    const line = `${time}  ${where}  —  ${reason}`;

                    node.sqErrors.push(line);
                    if (node.sqErrors.length > MAX_ERROR_LINES) node.sqErrors.shift();
                    node.sqScrollY = Math.max(0, node.sqErrors.length * 16 - LOG_H);
                    node.setDirtyCanvas(true, true);

                    callLogError(nodeId, line);
                }
                _handleRunEnd(node, nodeId);
            }
        });

        api.addEventListener("executing", (e) => {
            if (e.detail?.node) return; 
            for (const [nodeId, session] of Object.entries(_sessions)) {
                if (!session.ran || session.abort) continue;
                const node = app.graph._nodes.find((n) => n.id.toString() === nodeId);
                _handleRunEnd(node, nodeId);
            }
        });

        api.addEventListener("execution_interrupted", () => {
            for (const [nodeId, session] of Object.entries(_sessions)) {
                if (!session.ran) continue;
                session.abort = true;
                session.ran = false;
                
                const node = app.graph._nodes.find((n) => n.id.toString() === nodeId);
                if (node) {
                    node.sqStatus = "idle";
                    node.setDirtyCanvas(true, true);
                }
            }
        });
    },
});