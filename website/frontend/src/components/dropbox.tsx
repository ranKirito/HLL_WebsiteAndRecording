import { useCallback, useState } from 'react'
import { useDropzone } from 'react-dropzone'
import { UploadCloud } from 'lucide-react'
export default function DropBox({ updateReplaysToken, replaysToken }: { updateReplaysToken: () => void, replaysToken: number }) {
  const [uploadStatus, setUploadStatus] = useState<null | 'success' | 'error'>(null)

  const onDrop = useCallback((acceptedFiles: File[]) => {
    const file = acceptedFiles[0]
    if (!file) return

    const formData = new FormData()
    formData.append('replay', file)

    fetch('http://localhost:4000/upload', {
      method: 'POST',
      body: formData,
    })
      .then(res => {
        if (!res.ok) throw new Error('Upload failed')
        setUploadStatus('success')
      })
      .catch(() => {
        setUploadStatus('error')
      })
    console.log("Token number before: ", replaysToken);
    console.log(updateReplaysToken);
    updateReplaysToken();
    console.log("Token number after: ", replaysToken);
  }, [])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/octet-stream': ['.hll'] },
    multiple: false,
  })

  return (
    <div
      {...getRootProps()}
      className="w-[97%] mt-[10px] text-[var(--foreground)] h-[50%] border-2 border-dashed border-gray-400 rounded-lg p-8 text-center cursor-pointer hover:border-gray-600 hover:text-gray-400 transition-colors flex items-center justify-center flex-col"
    >
      <input {...getInputProps()} />
      {isDragActive ? (
        <>
          <UploadCloud className="w-8 h-8 mx-auto mb-2 opacity-70" />
          <p>Drop the .hll file here...</p>
        </>

      ) : (
        <>
          <UploadCloud className="w-8 h-8 mx-auto mb-2 opacity-70" />
          <p>Drag & drop your .hll replay file here, or click to select</p>
        </>

      )}
      {uploadStatus === 'success' && (
        <p className="text-green-600 mt-2">Upload successful!</p>
      )}
      {uploadStatus === 'error' && (
        <p className="text-red-600 mt-2">Upload failed. Try again.</p>
      )}
    </div>
  )
}
