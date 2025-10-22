import React, { useState, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getPageById, createBubble } from '../services/api';
import ValidationForm from '../components/ValidationForm';
import { useAuth } from '../context/AuthContext';
import styles from './AnnotatePage.module.css';

const AnnotatePage = () => {
  const { session } = useAuth();
  const { pageId } = useParams();
  const [page, setPage] = useState(null);
  const [error, setError] = useState(null);
  const containerRef = useRef(null);

  const [isDrawing, setIsDrawing] = useState(false);
  const [startPoint, setStartPoint] = useState(null);
  const [endPoint, setEndPoint] = useState(null);
  const [rectangle, setRectangle] = useState(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingBubble, setPendingBubble] = useState(null);

  useEffect(() => {
    getPageById(pageId, session?.access_token)
      .then(response => setPage(response.data))
      .catch(error => setError("Impossible de charger les données de la page."));
  }, [pageId, session]);

  useEffect(() => {
    const token = session?.access_token;
    if (rectangle && token) {
      setIsSubmitting(true);
      setPendingBubble(null);
      const bubbleData = {
        id_page: parseInt(pageId, 10),
        ...rectangle,
      };
      createBubble(bubbleData, token)
        .then(response => {
          setPendingBubble(response.data);
        })
        .catch(error => {
          console.error("Erreur lors de la création de la bulle:", error);
          setError("L'envoi de la bulle a échoué.");
        })
        .finally(() => {
          setIsSubmitting(false);
        });
    }
  }, [rectangle, pageId, session]);

  const getContainerCoords = (event) => {
    const container = containerRef.current;
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  };

  const handleMouseDown = (event) => {
    event.preventDefault();
    setIsDrawing(true);
    const coords = getContainerCoords(event);
    setStartPoint(coords);
    setEndPoint(coords);
    setRectangle(null);
  };

  const handleMouseMove = (event) => {
    if (!isDrawing) return;
    event.preventDefault();
    setEndPoint(getContainerCoords(event));
  };

  const handleMouseUp = (event) => {
    if (!isDrawing) return;
    event.preventDefault();
    setIsDrawing(false);
    const finalRect = {
      x: Math.round(Math.min(startPoint.x, endPoint.x)),
      y: Math.round(Math.min(startPoint.y, endPoint.y)),
      w: Math.round(Math.abs(startPoint.x - endPoint.x)),
      h: Math.round(Math.abs(startPoint.y - endPoint.y)),
    };
    if (finalRect.w > 5 && finalRect.h > 5) {
      setRectangle(finalRect);
    }
  };

  const getRectangleStyle = () => {
    if (!startPoint || !endPoint) return { display: 'none' };
    const left = Math.min(startPoint.x, endPoint.x);
    const top = Math.min(startPoint.y, endPoint.y);
    const width = Math.abs(startPoint.x - endPoint.x);
    const height = Math.abs(startPoint.y - endPoint.y);
    return { left, top, width, height };
  };

  const handleSuccess = () => {
    setPendingBubble(null);
    setRectangle(null);
  };

  if (error) return <div><p style={{color: 'red'}}>{error}</p><Link to="/">Retour</Link></div>;
  if (!page) return <div>Chargement...</div>;

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h2>Annotation - Page {page.numero_page}</h2>
        <Link to="/">Retour à la bibliothèque</Link>
      </header>
      
      <div className={styles.centerContainer}>
        <div 
          ref={containerRef}
          className={styles.imageContainer}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          <img 
            src={page.url_image} 
            alt={`Page ${page.numero_page}`} 
            className={styles.mangaImage}
            draggable="false"
          />
          
          {isDrawing && <div style={getRectangleStyle()} className={styles.drawingRectangle} />}
        </div>
        
        {isSubmitting && <div className={styles.loadingMessage}>Analyse OCR en cours...</div>}
        
        <ValidationForm bubble={pendingBubble} onValidationSuccess={handleSuccess} />
      </div>
    </div>
  );
};

export default AnnotatePage;