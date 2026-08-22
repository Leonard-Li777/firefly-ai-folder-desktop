import React from 'react';

interface MaterialIconProps extends React.HTMLAttributes<HTMLSpanElement> {
  icon: string;
  className?: string;
}

export const MaterialIcon: React.FC<MaterialIconProps> = ({ icon, className = '', ...props }) => {
  return (
    <span className={`material-icons text-2xl  ${className}`} {...props}>
      {icon}
    </span>
  );
};