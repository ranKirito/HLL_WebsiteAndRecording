export async function getReplays() {
  const url = 'http://localhost:4000/list';
  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      throw new Error(`HTTP error! Status: ${res.status}`);
    }
    const data = await res.json();
    console.log("Replay fetch successful", data);
    return data;
  } catch (e) {
    console.error("Replay fetch failed:", e);
    return null;
  }
}
