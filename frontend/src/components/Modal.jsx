import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import styles from './Modal.module.css';

const Modal = ({ isOpen, onClose, title, children }) => {
    const [isDragging, setIsDragging] = useState(false);
    const [position, setPosition] = useState({ x: 0, y: 0 });
    const [offset, setOffset] = useState({ x: 0, y: 0 });

    const modalRef = useRef(null);

    useEffect(() => {
        if (isOpen) {
            const centerModal = () => {
                if (modalRef.current) {
                    const modalRect = modalRef.current.getBoundingClientRect();
                    const initialX = (window.innerWidth / 2) - (modalRect.width / 2);
                    const initialY = (window.innerHeight / 2) - (modalRect.height / 2);
                    setPosition({ x: initialX, y: initialY });
                }
            };
            centerModal();
            window.addEventListener('resize', centerModal);
            return () => window.removeEventListener('resize', centerModal);
        }
    }, [isOpen]);

    const handleMouseDown = (e) => {
        if (!e.target.closest(`.${styles.modalHeader}`)) return;

        setIsDragging(true);
        if (modalRef.current) {
            const modalRect = modalRef.current.getBoundingClientRect();
            setOffset({
                x: e.clientX - modalRect.left,
                y: e.clientY - modalRect.top
            });
        }
    };

    const handleMouseMove = (e) => {
        if (!isDragging) return;
        setPosition({
            x: e.clientX - offset.x,
            y: e.clientY - offset.y
        });
    };

    const handleMouseUp = () => {
        setIsDragging(false);
    };

    useEffect(() => {
        if (isDragging) {
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        } else {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        }
        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isDragging, offset]);

    if (!isOpen) return null;

    const modalStyle = {
        transform: `translate(${position.x}px, ${position.y}px)`,
        position: 'fixed',
        margin: 0,
    };

    return ReactDOM.createPortal(
        <div className={styles.modalOverlay}>
            <div 
                ref={modalRef} 
                className={styles.modalContent} 
                style={modalStyle}
            >
                <div 
                    className={`${styles.modalHeader} ${isDragging ? styles.isDragging : ''}`}
                    onMouseDown={handleMouseDown}
                >
                    <h4 className={styles.modalTitle}>{title}</h4>
                    <button onClick={onClose} className={styles.closeButton}>&times;</button>
                </div>
                <div className={styles.modalBody}>
                    {children}
                </div>
            </div>
        </div>,
        document.body
    );
};

export default Modal;