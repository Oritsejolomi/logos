import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import './index.css';
import { App } from './App';
import { Home } from './routes/Home';
import { SoloSetup } from './routes/SoloSetup';
import { SoloPlay } from './routes/SoloPlay';
import { RoomNew } from './routes/RoomNew';
import { RoomJoin } from './routes/RoomJoin';
import { RoomLobby } from './routes/RoomLobby';
import { RoomPlay } from './routes/RoomPlay';
import { HallOfFame } from './routes/HallOfFame';

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Home /> },
      { path: 'solo', element: <SoloSetup /> },
      { path: 'solo/play', element: <SoloPlay /> },
      { path: 'room/new', element: <RoomNew /> },
      { path: 'room/join', element: <RoomJoin /> },
      { path: 'room/:code/lobby', element: <RoomLobby /> },
      { path: 'room/:code/play', element: <RoomPlay /> },
      { path: 'hall-of-fame', element: <HallOfFame /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
