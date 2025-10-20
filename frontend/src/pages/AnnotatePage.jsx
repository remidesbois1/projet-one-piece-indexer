import React, { useState, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getPageById } from '../services/api';
import * as fabric from 'fabric';

const AnnotatePage = () => {
  const { pageId } = useParams();
  const [page, setPage] = useState(null);
  const [error, setError] = useState(null);
  
  const canvasRef = useRef(null);
  const fabricRef = useRef(null);

  useEffect(() => {
    getPageById(pageId)
      .then(response => setPage(response.data))
      .catch(error => {
        console.error("Erreur de chargement de la page", error);
        setError("Impossible de charger la page.");
      });
  }, [pageId]);

  useEffect(() => {
    if (page && canvasRef.current) {
      const canvas = new fabric.Canvas(canvasRef.current, {
        width: 800,
        height: 1200,
      });
      fabricRef.current = canvas;

      fabric.Image.fromURL(page.url_image, (img) => {
        canvas.setBackgroundImage(img, canvas.renderAll.bind(canvas), {
          scaleX: canvas.width / img.width,
          scaleY: canvas.height / img.height,
        });
      }, { crossOrigin: 'anonymous' });
      
      return () => {
        canvas.dispose();
      };
    }
  }, [page]);

  if (error) return <div><p style={{color: 'red'}}>{error}</p><Link to="/">Retour à l'accueil</Link></div>;
  if (!page) return <div>Chargement de la page...</div>;

  return (
    <div>
      <div style={{ padding: '10px', background: '#f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>Annotation - Page {page.numero_page}</h2>
        <Link to="/">Retour à la sélection</Link>
      </div>
      
      <div style={{ textAlign: 'center', marginTop: '20px' }}>
        {/* Le canvas qui remplacera notre balise <img> */}
        <canvas ref={canvasRef} style={{ border: '1px solid black' }} />
      </div>
    </div>
  );
};

export default AnnotatePage;