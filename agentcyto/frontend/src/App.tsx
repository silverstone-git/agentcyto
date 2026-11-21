import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Shell from './components/layout/Shell'
import ChatPage from './pages/ChatPage'
import StatusPage from './pages/StatusPage'
import AdminPage from './pages/AdminPage'

function App() {
  return (
    <BrowserRouter basename="/">
      <Shell>
        <Routes>
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/status" element={<StatusPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/" element={<ChatPage />} />
        </Routes>
      </Shell>
    </BrowserRouter>
  )
}

export default App
