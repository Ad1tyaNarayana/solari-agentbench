import csv, hashlib, json, math, os, subprocess

submission = "/submission/source"
seed = "/benchmark/tasks/same-stats-different-graph/fixtures/seed.csv"
outputs = ["/result/replication-1", "/result/replication-2"]
for output in outputs:
    os.makedirs(output, exist_ok=True)
    completed = subprocess.run(["python3", "reproduce.py", "--input", seed, "--output", output, "--target", "circle", "--seed", "1729"], cwd=submission)
    if completed.returncode: raise SystemExit(completed.returncode)

def read_points(path):
    with open(path, newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    return [(float(row["x"]), float(row["y"])) for row in rows]

first_path, second_path = [os.path.join(output, "points.csv") for output in outputs]
points = read_points(first_path)
n = len(points)
xs, ys = zip(*points)
mx, my = sum(xs) / n, sum(ys) / n
vx = sum((x-mx)**2 for x in xs) / (n-1)
vy = sum((y-my)**2 for y in ys) / (n-1)
cov = sum((x-mx)*(y-my) for x,y in points) / (n-1)
corr = cov / math.sqrt(vx*vy) if vx and vy else 0
rmse = math.sqrt(sum((abs(math.hypot((x-54.27)/16.76, (y-47.84)/26.93)-1))**2 for x,y in points)/n)
with open(first_path, "rb") as a, open(second_path, "rb") as b: reproducible = hashlib.sha256(a.read()).digest() == hashlib.sha256(b.read()).digest()
result = {
  "assertions": [{"id":"reproducible", "passed":reproducible, "summary":"Seeded runs produce identical points.csv"}],
  "outputs": {"meanX":mx,"meanY":my,"varianceX":vx,"varianceY":vy,"correlation":corr,"ellipseRmse":rmse,"reproducible":reproducible},
  "evidence": []
}
with open(os.environ["AGENTBENCH_RESULT"], "w", encoding="utf-8") as handle: json.dump(result, handle)
