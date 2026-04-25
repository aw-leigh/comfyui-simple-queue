# ComfyUI Simple Queue

A lightweight, highly reliable directory batching node for ComfyUI. 

Simple Queue is designed to process a folder of images or videos sequentially. It auto-queues the next file until the folder is exhausted, survives server restarts, and cleanly captures downstream errors without breaking the batch loop.

## Features

* **Directory Scanning:** Point it at a folder, select an extension (.mp4, .mov, .png, .jpg), and it will iterate through the files alphabetically.
* **State Persistence:** The node remembers its place in the queue. If your ComfyUI server crashes or you need to restart mid-batch, the node will resume exactly where it left off.
* **Auto-Queuing:** Automatically triggers the next workflow run upon completion or error of the previous run.
* **Built-in Error Log:** If a downstream node fails (e.g., an Out of Memory error), Simple Queue skips the file, logs the error in a scrollable widget directly on the node, and continues with the next file.
* **Status UI:** Real-time progress tracking directly on the node canvas (e.g., "3 / 10 - video.mp4").
* **Manual Reset:** A dedicated button to clear the queue state and start fresh.

## Installation

1. Navigate to your ComfyUI `custom_nodes` directory
2. Clone this repository:
   ```bash
   git clone https://github.com/aw-leigh/comfyui-simple-queue.git
3. Restart ComfyUI

## Usage

* Add the Simple Queue node to your workflow (found under Video Processing).
* Input the absolute path to your target folder in the folder_path field.
* Select the desired file extension from the file_type dropdown.
* Connect the file_path (STRING) output to your Load Image, Load Video, or text parsing nodes.
* Click Queue Prompt. The node will process the first file, and automatically queue subsequent prompts until the folder is finished.

Note: To stop a batch mid-run, click "Cancel Prompt" in the ComfyUI menu. The node will retain its state. To restart from the beginning, click the "Reset Queue" button on the node.

## Technical Architecture

Batching is a notoriously difficult problem in ComfyUI. Because the Python execution graph is static per run, standard nodes cannot easily tell the server to "run this workflow again" without creating infinite loops or locking up the UI thread. Simple Queue solves this by splitting the responsibility between the backend and the frontend.

1. The Python Backend (State & Disk)
The Python side of the node acts as a strict state manager. When a prompt is executed, Python checks a local .json file stored in ComfyUI's temp directory. It reads the current index, increments it, and writes the state back to disk. This ensures that even if the Python server process is killed, the exact queue position is preserved. Python then sends a WebSocket message (simple_queue_update) to the frontend with the current file information.

2. The JavaScript Frontend (The Event Loop)
The JavaScript extension listens to ComfyUI's native WebSocket events (executing, execution_error, and execution_interrupted).
When it detects that the workflow has finished (whether successfully or by error), the JS waits briefly to let the server settle, and then explicitly calls app.queuePrompt(0, 1). This simulates a user clicking the "Queue Prompt" button, allowing ComfyUI to build a fresh execution graph for the next file.

3. Error and Cancellation Handling
If a downstream node throws an error, ComfyUI fires an execution_error event. The JS catches this, appends the error to the custom scrollable log widget, and queues the next prompt, preventing a single corrupted file from stopping an overnight batch. If the user manually cancels the prompt, execution_interrupted fires, and the JS intentionally drops the loop to prevent "zombie" re-queueing.
