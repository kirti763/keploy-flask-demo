from flask import Flask, request, jsonify

app = Flask(__name__)

# simple in-memory data store
items = []

@app.route("/health", methods=["GET"])
def health():
    return {"status": "ok"}

@app.route("/items", methods=["POST"])
def create_item():
    data = request.json
    items.append(data)
    return jsonify(data), 201

@app.route("/items", methods=["GET"])
def get_items():
    return jsonify(items)

if __name__ == "__main__":
    app.run(port=5000)
