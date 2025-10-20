import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getPageById, createBubble } from '../services/api';
import ValidationForm from '../components/ValidationForm';

const AnnotatePage = () => {
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
    getPageById(pageId)
      .then(response => setPage(response.data))
      .catch(error => setError("Impossible de charger les données de la page."));
  }, [pageId]);

  useEffect(() => {
    if (rectangle) {
      setIsSubmitting(true);
      setPendingBubble(null);
      const bubbleData = {
        id_page: parseInt(pageId, 10),
        ...rectangle,
      };
      createBubble(bubbleData)
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
  }, [rectangle, pageId]);

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
    return {
      position: 'absolute',
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
      border: '2px solid red',
      boxSizing: 'border-box',
    };
  };

  if (error) return <div><p style={{color: 'red'}}>{error}</p><Link to="/">Retour à l'accueil</Link></div>;
  if (!page) return <div>Chargement des données de la page...</div>;

  return (
    <div>
      <div style={{ padding: '10px', background: '#f0f0f0' }}>
        <h2>Annotation - Page {page.numero_page}</h2>
        <Link to="/">Retour à la sélection</Link>
      </div>
      
      <div 
        ref={containerRef}
        style={{ 
          position: 'relative', 
          display: 'inline-block',
          cursor: 'crosshair',
          marginTop: '20px',
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <img 
          src={page.url_image} 
          alt={`Page ${page.numero_page}`} 
          style={{ maxWidth: '800px', display: 'block' }}
          draggable="false"
        />
        
        {isDrawing && <div style={getRectangleStyle()} />}
      </div>
      
      {isSubmitting && <div style={{textAlign: 'center', padding: '10px'}}>Analyse OCR en cours...</div>}
      
      <ValidationForm bubble={pendingBubble} />
    </div>
  );
};

export default AnnotatePage;