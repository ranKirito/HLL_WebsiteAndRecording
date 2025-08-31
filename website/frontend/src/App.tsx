import { useState } from 'react'
import './App.css'
import SideBar from './components/sidebar'
import DropBox from './components/dropbox'


export default function App() {
  const [replaysToken, setReplaysToken] = useState(0);
  const updateReplaysToken = () => {
    setReplaysToken((prev) => prev + 1);
  }
  return (
    <div className="flex h-screen dark w-screen">
      <SideBar replaysToken={replaysToken} updateReplaysToken={updateReplaysToken} />
      <main className="flex-1 flex items-start justify-center w-[80%] bg-[var(--background)]">
        <DropBox replaysToken={replaysToken} updateReplaysToken={updateReplaysToken} />
      </main>
    </div>
  )
}


