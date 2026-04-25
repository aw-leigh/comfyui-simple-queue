import os
import json
import threading
from aiohttp import web
from server import PromptServer
import folder_paths

# ── shared state ──────────────────────────────────────────────────────────────
_state_lock  = threading.Lock()
_queue_states = {}

# ── disk helpers ──────────────────────────────────────────────────────────────
def _state_path(uid):
    return os.path.join(folder_paths.get_temp_directory(), f"sq_state_{uid}.json")

def _log_path(uid):
    return os.path.join(folder_paths.get_temp_directory(), f"sq_errors_{uid}.log")

def _load_state_from_disk(uid):
    try:
        with open(_state_path(uid), "r") as f:
            return json.load(f)
    except Exception:
        return None

def _save_state_locked(uid, state):
    try:
        with open(_state_path(uid), "w") as f:
            json.dump(state, f)
    except Exception as e:
        print(f"[SimpleQueue] Could not save state: {e}")

def _clear_state_locked(uid):
    _queue_states.pop(uid, None)
    try:
        p = _state_path(uid)
        if os.path.exists(p):
            os.remove(p)
    except Exception as e:
        print(f"[SimpleQueue] Could not remove state file: {e}")

def _clear_state(uid):
    with _state_lock:
        _clear_state_locked(uid)

def _append_error_log(uid, message):
    try:
        with open(_log_path(uid), "a") as f:
            f.write(message + "\n")
    except Exception as e:
        print(f"[SimpleQueue] Could not write error log: {e}")

# ── node ──────────────────────────────────────────────────────────────────────
class SimpleQueue:
    FILE_TYPES = [".mp4", ".mov", ".png", ".jpg"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "folder_path": ("STRING", {"default": ""}),
                "file_type":   (cls.FILE_TYPES,),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    RETURN_TYPES  = ("STRING",)
    RETURN_NAMES  = ("file_path",)
    FUNCTION      = "process"
    CATEGORY      = "Video Processing"

    def process(self, folder_path, file_type, unique_id):
        with _state_lock:
            state = _queue_states.get(unique_id)
            if state is None:
                state = _load_state_from_disk(unique_id)
                if state is not None:
                    _queue_states[unique_id] = state

            stale = (
                state is None
                or state.get("folder")    != folder_path
                or state.get("file_type") != file_type
            )
            if stale:
                try:
                    names = sorted(
                        f for f in os.listdir(folder_path)
                        if f.lower().endswith(file_type)
                    )
                except Exception as e:
                    raise ValueError(f"[SimpleQueue] Cannot read '{folder_path}': {e}")

                if not names:
                    raise ValueError(f"[SimpleQueue] No {file_type} files found in '{folder_path}'")

                state = {
                    "folder":    folder_path,
                    "file_type": file_type,
                    "files":     [os.path.join(folder_path, n) for n in names],
                    "index":     0,
                }
                _queue_states[unique_id] = state
                _save_state_locked(unique_id, state)

            files = state["files"]
            index = state["index"]
            total = len(files)

            if index >= total:
                _clear_state_locked(unique_id)
                raise ValueError(
                    "[SimpleQueue] Queue index out of range — state has been reset. "
                    "Re-run the workflow to start from the beginning."
                )

            current_file = files[index]
            next_index   = index + 1
            has_more     = next_index < total

            # FIX: Always save the state (so we don't lose it if the last file errors)
            # We let the JS handle clearing the state when the batch is truly complete
            state["index"] = next_index
            _save_state_locked(unique_id, state)

            PromptServer.instance.send_sync("simple_queue_update", {
                "node_id":  unique_id,
                "index":    index,
                "total":    total,
                "filename": os.path.basename(current_file),
                "has_more": has_more,
            })

        return (current_file,)

# ── endpoints ─────────────────────────────────────────────────────────────────
@PromptServer.instance.routes.post("/simple_queue/reset")
async def reset_queue(request):
    data = await request.json()
    _clear_state(str(data.get("node_id", "")))
    return web.json_response({"status": "ok"})

@PromptServer.instance.routes.post("/simple_queue/log_error")
async def log_error(request):
    data    = await request.json()
    uid     = str(data.get("node_id", ""))
    message = data.get("message", "Unknown error")
    _append_error_log(uid, message)
    return web.json_response({"status": "ok"})