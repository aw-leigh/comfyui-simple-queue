from .simple_queue import SimpleQueue

NODE_CLASS_MAPPINGS = {
    "SimpleQueue": SimpleQueue,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SimpleQueue": "Simple Queue",
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]