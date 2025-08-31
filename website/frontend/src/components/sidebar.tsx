import { Input } from "./ui/input"
import { useState, useEffect } from "react"
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "./ui/table"
import { ScrollArea } from "./ui/scroll-area"
import { getReplays } from "@/api/getReplays"
import protobuf from 'protobufjs';
import { useReplay } from "@/replayContext"
let RecordMessage: protobuf.Type | null = null;


// Load the protobuf schema
protobuf.load("/record.proto").then((root) => {
  RecordMessage = root.lookupType("record.MatchData");
});

type Replay = {
  id: string;
  filename: string;
  originalname: string;
  map: string;
  duration: number;
  createdAt: string;
}


export default function SideBar({ replaysToken, updateReplaysToken }: { replaysToken: number, updateReplaysToken: () => void }) {
  const [mapName, setMapName] = useState('')
  const [replays, setReplays] = useState<Replay[]>([]);
  const { replay, setReplay } = useReplay();
  useEffect(() => {
    const fetchReplays = async () => {
      const data = await getReplays();
      setReplays(data);
    };
    fetchReplays();
  }, [replaysToken])

  const filteredReplays = replays.filter((replay) => { return replay.map.includes(mapName.toLowerCase()) })

  const handleReplaySelection = async (id: string) => {
    const res = await fetch(`http://localhost:4000/replay/${id}`);
    const arrayBuffer = await res.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);

    try {
      if (RecordMessage != null) {
        const decoded = RecordMessage.decode(buffer);
        const data = RecordMessage.toObject(decoded, { defaults: true });
        console.log("Parsed replay data:", data);
        setReplay(data);
      } else {
        console.log("IT doesnt work skill issue");
      }

    } catch (err) {
      console.error("Failed to parse replay:", err);
    }

  }

  return (
    <div className="w-[25%] p-[10px] bg-[var(--sidebar)] text-[var(--foreground)] flex flex-col justify-start overflow-hidden">
      <h2 className="text-start font-semibold mb-4 w-full">Saved Games</h2>
      <Input
        placeholder="Search..."
        className="mb-4"
        onChange={(event) => {
          setMapName(event.target.value)
        }}
      />

      <ScrollArea className="h-[calc(100%-100px)]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Filename</TableHead>
              <TableHead>Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredReplays.map((replay, index) => (
              <TableRow className="cursor-pointer" key={replay.id} onClick={() => handleReplaySelection(replay.id)}>
                <TableCell>{replay.map}</TableCell>
                <TableCell>{new Date(replay.createdAt).toLocaleString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollArea>
    </div>
  )
}
