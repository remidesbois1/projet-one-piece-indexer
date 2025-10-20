import React, { useState, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getPageById } from '../services/api';

const AnnotatePage = () => {
  const { pageId } = useParams();
  const [page, setPage] = useState(null);
  const [error, setError] = useState(null);
  
  // Réf pour le conteneur de l'image
  const containerRef = useRef(null);

  const [isDrawing, setIsDrawing] = useState(false);
  const [startPoint, setStartPoint] = useState(null);
  const [endPoint, setEndPoint] = useState(null);
  const [rectangle, setRectangle] = useState(null);

  useEffect(() => {
    getPageById(pageId)
      .then(response => setPage(response.data))
      .catch(error => setError("Impossible de charger les données de la page."));
  }, [pageId]);

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
      console.log("Rectangle final :", finalRect);
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
      
      {/* Le conteneur qui écoutera les événements de la souris */}
      <div 
        ref={containerRef}
        style={{ 
          position: 'relative', 
          display: 'inline-block', // Pour que le conteneur prenne la taille de l'image
          cursor: 'crosshair',
          marginTop: '20px',
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp} // Si la souris sort du cadre, on arrête le dessin
      >
        <img 
          src={page.url_image} 
          alt={`Page ${page.numero_page}`} 
          style={{ maxWidth: '800px', display: 'block' }} // 'display: block' pour éviter un petit espace sous l'image
          draggable="false" // Empêche de "glisser-déposer" l'image
        />
        
        {/* Le div qui représente le rectangle en cours de dessin */}
        {isDrawing && <div style={getRectangleStyle()} />}
      </div>
      
      {rectangle && (
        <div style={{ textAlign: 'center', marginTop: '10px', background: 'lightgreen', padding: '10px' }}>
          <h3>Rectangle Dessiné !</h3>
          <pre>{JSON.stringify(rectangle, null, 2)}</pre>
        </div>
      )}
    </div>
  );
};

export default AnnotatePage;